import { HttpError, UUID_RE, type ToolContext } from "@founderos/sdk";
import { computeStageStats, DEFAULT_STALE_DAYS, isoDay, normalizeEmail, OPEN_STAGES, type Stage } from "./logic";

const DAY_MS = 86_400_000;

export interface Contact {
  id: string; type: string; name: string; company: string; email: string; phone: string; status: string; source: string;
  tags: string[]; notes: string; createdBy: string; createdAt: string; updatedAt: string; lastActivityAt: string;
}
export interface Opportunity {
  id: string; contactId: string; contactName: string; title: string; valueCents: number; stage: Stage; expectedClose: string | null;
  lostReason: string; owner: string; createdAt: string; updatedAt: string; lastActivityAt: string; stageChangedAt: string; closedAt: string | null;
}
export interface TimelineEntry {
  kind: "note" | "stage";
  at: string;
  author: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  body?: string;
  fromStage?: string | null;
  toStage?: string;
}

interface ContactRow {
  id: string; type: string; name: string; company: string; email: string; phone: string; status: string; source: string;
  tags: string[]; notes: string; created_by: string; created_at: Date; updated_at: Date; last_activity_at: Date;
}
interface OppRow {
  id: string; contact_id: string; contact_name: string; title: string; value_cents: string | number; stage: Stage; expected_close: string | null;
  lost_reason: string; owner: string; created_at: Date; updated_at: Date; last_activity_at: Date; stage_changed_at: Date; closed_at: Date | null;
}

const iso = (d: Date) => d.toISOString();
export const toContact = (r: ContactRow): Contact => ({
  id: r.id, type: r.type, name: r.name, company: r.company, email: r.email, phone: r.phone, status: r.status, source: r.source,
  tags: r.tags, notes: r.notes, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), lastActivityAt: iso(r.last_activity_at),
});
export const toOpp = (r: OppRow): Opportunity => ({
  id: r.id, contactId: r.contact_id, contactName: r.contact_name, title: r.title, valueCents: Number(r.value_cents), stage: r.stage,
  expectedClose: r.expected_close, lostReason: r.lost_reason, owner: r.owner, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  lastActivityAt: iso(r.last_activity_at), stageChangedAt: iso(r.stage_changed_at), closedAt: r.closed_at ? iso(r.closed_at) : null,
});

export const likePattern = (q: string) => "%" + q.trim().replace(/[\\%_]/g, "\\$&") + "%";

const CONTACT_COLS = (ctx: ToolContext) => ctx.sql`id, type, name, company, email, phone, status, source, tags, notes, created_by, created_at, updated_at, last_activity_at`;
const OPP_SELECT = (ctx: ToolContext) => ctx.sql`
  SELECT o.id, o.contact_id, c.name AS contact_name, o.title, o.value_cents, o.stage, to_char(o.expected_close, 'YYYY-MM-DD') AS expected_close,
         o.lost_reason, o.owner, o.created_at, o.updated_at, o.last_activity_at, o.stage_changed_at, o.closed_at
  FROM crm_opportunities o JOIN crm_contacts c ON c.id = o.contact_id AND c.business_id = o.business_id`;

export function id(v: string): string {
  if (!UUID_RE.test(v)) throw new HttpError(404, "Not found");
  return v;
}

export async function listContacts(ctx: ToolContext, f: { q?: string; type?: string; status?: string; tag?: string; limit?: number } = {}): Promise<Contact[]> {
  const q = f.q?.trim();
  const like = q ? likePattern(q) : null;
  const rows = await ctx.sql<ContactRow[]>`
    SELECT ${CONTACT_COLS(ctx)} FROM crm_contacts
    WHERE business_id = ${ctx.businessId}
      ${f.type ? ctx.sql`AND type = ${f.type}` : ctx.sql``}
      ${f.status ? ctx.sql`AND status = ${f.status}` : ctx.sql``}
      ${f.tag ? ctx.sql`AND ${f.tag.toLowerCase()} = ANY (SELECT lower(t) FROM unnest(tags) AS t)` : ctx.sql``}
      ${like ? ctx.sql`AND (name ILIKE ${like} OR company ILIKE ${like} OR email ILIKE ${like} OR notes ILIKE ${like})` : ctx.sql``}
    ORDER BY lower(name), created_at LIMIT ${Math.min(f.limit ?? 500, 2000)}`;
  return rows.map(toContact);
}

export async function getContact(ctx: ToolContext, contactId: string): Promise<Contact | null> {
  if (!UUID_RE.test(contactId)) return null;
  const [r] = await ctx.sql<ContactRow[]>`SELECT ${CONTACT_COLS(ctx)} FROM crm_contacts WHERE id = ${contactId} AND business_id = ${ctx.businessId}`;
  return r ? toContact(r) : null;
}

export async function requireContact(ctx: ToolContext, contactId: string): Promise<Contact> {
  const c = await getContact(ctx, id(contactId));
  if (!c) throw new HttpError(404, "Contact not found");
  return c;
}

export async function listOpportunities(ctx: ToolContext, f: { contactId?: string; stage?: string; limit?: number } = {}): Promise<Opportunity[]> {
  const rows = await ctx.sql<OppRow[]>`
    ${OPP_SELECT(ctx)}
    WHERE o.business_id = ${ctx.businessId}
      ${f.contactId ? ctx.sql`AND o.contact_id = ${f.contactId}` : ctx.sql``}
      ${f.stage ? ctx.sql`AND o.stage = ${f.stage}` : ctx.sql``}
    ORDER BY o.updated_at DESC LIMIT ${Math.min(f.limit ?? 1000, 2000)}`;
  return rows.map(toOpp);
}

export async function getOpportunity(ctx: ToolContext, oppId: string): Promise<Opportunity | null> {
  if (!UUID_RE.test(oppId)) return null;
  const [r] = await ctx.sql<OppRow[]>`${OPP_SELECT(ctx)} WHERE o.id = ${oppId} AND o.business_id = ${ctx.businessId}`;
  return r ? toOpp(r) : null;
}

export async function requireOpportunity(ctx: ToolContext, oppId: string): Promise<Opportunity> {
  const o = await getOpportunity(ctx, id(oppId));
  if (!o) throw new HttpError(404, "Opportunity not found");
  return o;
}

/** Other contacts in this business with the same email (case-insensitive). Never matches blank emails. */
export async function findDuplicates(ctx: ToolContext, email: string, excludeId?: string): Promise<{ id: string; name: string }[]> {
  const e = normalizeEmail(email);
  if (!e) return [];
  return ctx.sql<{ id: string; name: string }[]>`
    SELECT id, name FROM crm_contacts
    WHERE business_id = ${ctx.businessId} AND lower(email) = ${e} ${excludeId ? ctx.sql`AND id <> ${excludeId}` : ctx.sql``}
    ORDER BY created_at LIMIT 5`;
}

/** Records activity on a contact (and optionally one of its opportunities) so the staleness clock restarts. */
export async function touch(ctx: ToolContext, contactId: string, oppId?: string, now = new Date()): Promise<void> {
  await ctx.sql`UPDATE crm_contacts SET last_activity_at = ${now} WHERE id = ${contactId} AND business_id = ${ctx.businessId}`;
  if (oppId) await ctx.sql`UPDATE crm_opportunities SET last_activity_at = ${now} WHERE id = ${oppId} AND business_id = ${ctx.businessId}`;
}

export async function timeline(ctx: ToolContext, contactId: string, oppId?: string): Promise<TimelineEntry[]> {
  const notes = await ctx.sql<{ body: string; author: string; created_at: Date; opportunity_id: string | null; title: string | null }[]>`
    SELECT n.body, n.author, n.created_at, n.opportunity_id, o.title
    FROM crm_notes n LEFT JOIN crm_opportunities o ON o.id = n.opportunity_id AND o.business_id = n.business_id
    WHERE n.business_id = ${ctx.businessId} AND n.contact_id = ${contactId}
      ${oppId ? ctx.sql`AND n.opportunity_id = ${oppId}` : ctx.sql``}
    ORDER BY n.created_at DESC LIMIT 200`;
  const stages = await ctx.sql<{ from_stage: string | null; to_stage: string; changed_by: string; changed_at: Date; opportunity_id: string; title: string }[]>`
    SELECT h.from_stage, h.to_stage, h.changed_by, h.changed_at, h.opportunity_id, o.title
    FROM crm_stage_history h JOIN crm_opportunities o ON o.id = h.opportunity_id AND o.business_id = h.business_id
    WHERE h.business_id = ${ctx.businessId} AND o.contact_id = ${contactId}
      ${oppId ? ctx.sql`AND h.opportunity_id = ${oppId}` : ctx.sql``}
    ORDER BY h.changed_at DESC LIMIT 200`;
  const entries: TimelineEntry[] = [
    ...notes.map((n): TimelineEntry => ({ kind: "note", at: iso(n.created_at), author: n.author, opportunityId: n.opportunity_id, opportunityTitle: n.title, body: n.body })),
    ...stages.map((s): TimelineEntry => ({ kind: "stage", at: iso(s.changed_at), author: s.changed_by, opportunityId: s.opportunity_id, opportunityTitle: s.title, fromStage: s.from_stage, toStage: s.to_stage })),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export async function pipeline(ctx: ToolContext, now = new Date(), staleDays = DEFAULT_STALE_DAYS) {
  const opps = await listOpportunities(ctx);
  const cutoff = now.getTime() - staleDays * DAY_MS;
  const today = isoDay(now);
  const columns = (["lead", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as Stage[]).map((stage) => {
    const items = opps.filter((o) => o.stage === stage).map((o) => ({
      ...o,
      stale: (OPEN_STAGES as readonly string[]).includes(o.stage) && new Date(o.lastActivityAt).getTime() <= cutoff,
      pastClose: (OPEN_STAGES as readonly string[]).includes(o.stage) && !!o.expectedClose && o.expectedClose < today,
    }));
    return { stage, count: items.length, totalCents: items.reduce((s, o) => s + o.valueCents, 0), items };
  });
  const history = await ctx.sql<{ opportunity_id: string; from_stage: string | null; to_stage: string; changed_at: Date }[]>`
    SELECT opportunity_id, from_stage, to_stage, changed_at FROM crm_stage_history WHERE business_id = ${ctx.businessId}`;
  const stats = computeStageStats(history.map((h) => ({ opportunityId: h.opportunity_id, fromStage: h.from_stage, toStage: h.to_stage, changedAt: h.changed_at })), now);
  return { columns, stats, staleDays };
}

/** Open opportunities with no activity for `days`, oldest first. */
export async function staleOpportunities(ctx: ToolContext, now = new Date(), days = DEFAULT_STALE_DAYS): Promise<Opportunity[]> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await ctx.sql<OppRow[]>`
    ${OPP_SELECT(ctx)}
    WHERE o.business_id = ${ctx.businessId} AND o.stage = ANY (${[...OPEN_STAGES]}::text[]) AND o.last_activity_at <= ${cutoff}
    ORDER BY o.last_activity_at ASC LIMIT 200`;
  return rows.map(toOpp);
}

/** Open opportunities whose expected close date is before today. */
export async function pastCloseOpportunities(ctx: ToolContext, now = new Date()): Promise<Opportunity[]> {
  const rows = await ctx.sql<OppRow[]>`
    ${OPP_SELECT(ctx)}
    WHERE o.business_id = ${ctx.businessId} AND o.stage = ANY (${[...OPEN_STAGES]}::text[]) AND o.expected_close < ${isoDay(now)}::date
    ORDER BY o.expected_close ASC LIMIT 200`;
  return rows.map(toOpp);
}

/** Active leads with no open opportunity and no activity for `days`. */
export async function staleLeadContacts(ctx: ToolContext, now = new Date(), days = DEFAULT_STALE_DAYS): Promise<{ id: string; name: string; lastActivityAt: string }[]> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await ctx.sql<{ id: string; name: string; last_activity_at: Date }[]>`
    SELECT c.id, c.name, c.last_activity_at FROM crm_contacts c
    WHERE c.business_id = ${ctx.businessId} AND c.type = 'lead' AND c.status = 'active' AND c.last_activity_at <= ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.contact_id = c.id AND o.business_id = c.business_id AND o.stage = ANY (${[...OPEN_STAGES]}::text[]))
    ORDER BY c.last_activity_at ASC LIMIT 200`;
  return rows.map((r) => ({ id: r.id, name: r.name, lastActivityAt: iso(r.last_activity_at) }));
}
