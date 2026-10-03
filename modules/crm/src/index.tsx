import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, type AttentionItem, type SearchHit, type ToolContext, type ToolDef } from "@founderos/sdk";
import {
  findDuplicates, getContact, getOpportunity, id, likePattern, listContacts, listOpportunities, pastCloseOpportunities, pipeline,
  requireContact, requireOpportunity, staleLeadContacts, staleOpportunities, timeline, toContact, touch, type Contact,
} from "./data";
import {
  CONTACT_STATUSES, CONTACT_TYPES, daysBetween, DEFAULT_STALE_DAYS, EMAIL_RE, formatUsd, isOpenStage, normalizeEmail, OPEN_STAGES,
  parseContactsCsv, STAGES, toCsv, type Stage,
} from "./logic";
import { ContactDetail, ContactsView, OpportunityDetail, PipelineView } from "./ui/CrmApp";

const DAY_MS = 86_400_000;

const emailField = z.string().trim().max(254).refine((v) => v === "" || EMAIL_RE.test(v), "Not a valid email address");
const contactShape = {
  type: z.enum(CONTACT_TYPES),
  name: z.string().trim().min(1).max(200),
  company: z.string().trim().max(200),
  email: emailField,
  phone: z.string().trim().max(40),
  status: z.enum(CONTACT_STATUSES),
  source: z.string().trim().max(100),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  notes: z.string().max(5000),
};
const CreateContact = z.object({ ...contactShape, allowDuplicate: z.boolean().optional() }).partial({ type: true, company: true, email: true, phone: true, status: true, source: true, tags: true, notes: true });
const PatchContact = z.object(contactShape).partial().extend({ allowDuplicate: z.boolean().optional() });

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((v) => !Number.isNaN(Date.parse(v)), "Not a real date");
const oppShape = {
  title: z.string().trim().min(1).max(200),
  valueCents: z.number().int().min(0).max(1e12),
  expectedClose: dateField.nullable(),
  owner: z.string().trim().max(100),
};
const CreateOpp = z.object({ contactId: z.string(), stage: z.enum(STAGES).optional(), lostReason: z.string().trim().max(500).optional(), ...oppShape }).partial({ valueCents: true, expectedClose: true, owner: true });
const PatchOpp = z.object({ ...oppShape, lostReason: z.string().trim().max(500) }).partial();
const StageBody = z.object({ stage: z.enum(STAGES), lostReason: z.string().trim().max(500).optional() });
const NoteBody = z.object({ body: z.string().trim().min(1).max(5000) });
const ImportBody = z.object({ csv: z.string().max(2_000_000), allowDuplicates: z.boolean().optional() });

const params = (req: Request) => new URL(req.url).searchParams;
const staleDaysOf = (req: Request) => {
  const n = Number(params(req).get("staleDays"));
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_STALE_DAYS;
};

async function createOpportunityRow(ctx: ToolContext, v: { contactId: string; title: string; valueCents: number; stage: Stage; expectedClose: string | null; owner: string; lostReason: string }, now = new Date()) {
  const closed = !isOpenStage(v.stage);
  return ctx.sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO crm_opportunities (business_id, contact_id, title, value_cents, stage, expected_close, lost_reason, owner, created_at, updated_at, last_activity_at, stage_changed_at, closed_at)
      VALUES (${ctx.businessId}, ${v.contactId}, ${v.title}, ${v.valueCents}, ${v.stage}, ${v.expectedClose}, ${v.stage === "lost" ? v.lostReason : ""}, ${v.owner}, ${now}, ${now}, ${now}, ${now}, ${closed ? now : null})
      RETURNING id`;
    await tx`INSERT INTO crm_stage_history (business_id, opportunity_id, from_stage, to_stage, changed_by, changed_at) VALUES (${ctx.businessId}, ${row.id}, NULL, ${v.stage}, ${ctx.userId}, ${now})`;
    await tx`UPDATE crm_contacts SET last_activity_at = ${now} WHERE id = ${v.contactId} AND business_id = ${ctx.businessId}`;
    return row.id;
  });
}

async function changeStage(ctx: ToolContext, oppId: string, stage: Stage, lostReason: string | undefined, now = new Date()) {
  const opp = await requireOpportunity(ctx, oppId);
  if (opp.stage === stage) return opp;
  if (stage === "lost" && !lostReason?.trim()) throw new HttpError(400, "lostReason: say why the opportunity was lost");
  const closed = !isOpenStage(stage);
  await ctx.sql.begin(async (tx) => {
    await tx`
      UPDATE crm_opportunities SET stage = ${stage}, stage_changed_at = ${now}, closed_at = ${closed ? now : null}, lost_reason = ${stage === "lost" ? lostReason!.trim() : ""},
        updated_at = ${now}, last_activity_at = ${now}
      WHERE id = ${opp.id} AND business_id = ${ctx.businessId}`;
    await tx`INSERT INTO crm_stage_history (business_id, opportunity_id, from_stage, to_stage, changed_by, changed_at) VALUES (${ctx.businessId}, ${opp.id}, ${opp.stage}, ${stage}, ${ctx.userId}, ${now})`;
    await tx`UPDATE crm_contacts SET last_activity_at = ${now} WHERE id = ${opp.contactId} AND business_id = ${ctx.businessId}`;
  });
  return (await getOpportunity(ctx, opp.id))!;
}

const csvResponse = (body: string, filename: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` } });

export const tool: ToolDef = {
  id: "crm",
  name: "CRM",
  description: "Contacts, a sales pipeline, notes and follow-up reminders for a small business. Flags deals that have gone quiet.",
  group: "growth",
  status: "live",
  migrations: [
    {
      name: "0001_crm",
      sql: `
      CREATE TABLE crm_contacts (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        type             text NOT NULL DEFAULT 'lead' CHECK (type IN ('lead','customer','vendor','partner')),
        name             text NOT NULL,
        company          text NOT NULL DEFAULT '',
        email            text NOT NULL DEFAULT '',
        phone            text NOT NULL DEFAULT '',
        status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        source           text NOT NULL DEFAULT '',
        tags             text[] NOT NULL DEFAULT '{}',
        notes            text NOT NULL DEFAULT '',
        created_by       text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        last_activity_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX crm_contacts_business ON crm_contacts (business_id, lower(name));
      CREATE INDEX crm_contacts_email ON crm_contacts (business_id, lower(email)) WHERE email <> '';

      CREATE TABLE crm_opportunities (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        contact_id       uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
        title            text NOT NULL,
        value_cents      bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
        stage            text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead','contacted','qualified','proposal_sent','negotiation','won','lost')),
        expected_close   date,
        lost_reason      text NOT NULL DEFAULT '',
        owner            text NOT NULL DEFAULT '',
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        last_activity_at timestamptz NOT NULL DEFAULT now(),
        stage_changed_at timestamptz NOT NULL DEFAULT now(),
        closed_at        timestamptz
      );
      CREATE INDEX crm_opportunities_business ON crm_opportunities (business_id, stage);
      CREATE INDEX crm_opportunities_contact ON crm_opportunities (contact_id);

      CREATE TABLE crm_notes (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        contact_id     uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
        opportunity_id uuid REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        body           text NOT NULL,
        author         text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX crm_notes_contact ON crm_notes (business_id, contact_id, created_at DESC);

      CREATE TABLE crm_stage_history (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        opportunity_id uuid NOT NULL REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        from_stage     text,
        to_stage       text NOT NULL,
        changed_by     text NOT NULL,
        changed_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX crm_stage_history_opp ON crm_stage_history (business_id, opportunity_id, changed_at);`,
    },
  ],

  api: route({
    /* ---- contacts ---- */
    "GET contacts": async (ctx, req) => {
      const p = params(req);
      const type = p.get("type") ?? undefined;
      const status = p.get("status") ?? undefined;
      if (type && !(CONTACT_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "type: unknown contact type");
      if (status && !(CONTACT_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "status: unknown status");
      return json({ contacts: await listContacts(ctx, { q: p.get("q") ?? undefined, type, status, tag: p.get("tag") ?? undefined }) });
    },
    "GET contacts/export": async (ctx) => {
      const rows = await listContacts(ctx, { limit: 2000 });
      const body = toCsv(
        ["name", "company", "email", "phone", "type", "tags", "status", "source", "created"],
        rows.map((c) => [c.name, c.company, c.email, c.phone, c.type, c.tags.join(";"), c.status, c.source, c.createdAt.slice(0, 10)]),
      );
      return csvResponse(body, "contacts.csv");
    },
    "POST contacts/import": async (ctx, req) => {
      requireWrite(ctx);
      const body = await readJson(req, ImportBody);
      const parsed = parseContactsCsv(body.csv);
      if (parsed.fatal) throw new HttpError(400, parsed.fatal);
      const errors = [...parsed.errors];
      let rows = parsed.rows;
      if (!body.allowDuplicates && rows.some((r) => r.email)) {
        const emails = [...new Set(rows.filter((r) => r.email).map((r) => normalizeEmail(r.email)))];
        const existing = await ctx.sql<{ email: string }[]>`SELECT DISTINCT lower(email) AS email FROM crm_contacts WHERE business_id = ${ctx.businessId} AND lower(email) = ANY (${emails}::text[])`;
        const have = new Set(existing.map((e) => e.email));
        rows = rows.filter((r) => {
          if (r.email && have.has(normalizeEmail(r.email))) { errors.push({ line: r.line, error: "a contact with this email already exists" }); return false; }
          return true;
        });
      }
      const now = new Date();
      await ctx.sql.begin(async (tx) => {
        for (const r of rows) {
          await tx`
            INSERT INTO crm_contacts (business_id, type, name, company, email, phone, source, tags, created_by, created_at, updated_at, last_activity_at)
            VALUES (${ctx.businessId}, ${r.type}, ${r.name}, ${r.company}, ${r.email}, ${r.phone}, 'csv import', ${r.tags}::text[], ${ctx.userId}, ${now}, ${now}, ${now})`;
        }
      });
      errors.sort((a, b) => a.line - b.line);
      return json({ created: rows.length, errors });
    },
    "GET duplicates": async (ctx, req) => {
      const email = params(req).get("email") ?? "";
      const ex = params(req).get("excludeId");
      return json({ duplicates: await findDuplicates(ctx, email, ex && UUID_RE.test(ex) ? ex : undefined) });
    },
    "POST contacts": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, CreateContact);
      const email = b.email ?? "";
      const dupes = await findDuplicates(ctx, email);
      if (dupes.length && !b.allowDuplicate) return json({ error: "A contact with this email already exists", duplicates: dupes }, 409);
      const [row] = await ctx.sql<Parameters<typeof toContact>[0][]>`
        INSERT INTO crm_contacts (business_id, type, name, company, email, phone, status, source, tags, notes, created_by)
        VALUES (${ctx.businessId}, ${b.type ?? "lead"}, ${b.name!}, ${b.company ?? ""}, ${email}, ${b.phone ?? ""}, ${b.status ?? "active"}, ${b.source ?? ""}, ${b.tags ?? []}::text[], ${b.notes ?? ""}, ${ctx.userId})
        RETURNING id, type, name, company, email, phone, status, source, tags, notes, created_by, created_at, updated_at, last_activity_at`;
      return json({ contact: toContact(row), duplicates: dupes }, 201);
    },
    "GET contacts/:id": async (ctx, _req, p) => {
      const contact = await requireContact(ctx, p.id);
      const [opportunities, entries] = await Promise.all([listOpportunities(ctx, { contactId: contact.id }), timeline(ctx, contact.id)]);
      return json({ contact, opportunities, timeline: entries });
    },
    "PATCH contacts/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const cur = await requireContact(ctx, p.id);
      const b = await readJson(req, PatchContact);
      if (b.email !== undefined && normalizeEmail(b.email) !== normalizeEmail(cur.email) && !b.allowDuplicate) {
        const dupes = await findDuplicates(ctx, b.email, cur.id);
        if (dupes.length) return json({ error: "A contact with this email already exists", duplicates: dupes }, 409);
      }
      const n = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== "allowDuplicate")) } as Contact;
      const now = new Date();
      await ctx.sql`
        UPDATE crm_contacts SET type = ${n.type}, name = ${n.name}, company = ${n.company}, email = ${n.email}, phone = ${n.phone}, status = ${n.status},
          source = ${n.source}, tags = ${n.tags}::text[], notes = ${n.notes}, updated_at = ${now}, last_activity_at = ${now}
        WHERE id = ${cur.id} AND business_id = ${ctx.businessId}`;
      return json({ contact: await getContact(ctx, cur.id) });
    },
    "DELETE contacts/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM crm_contacts WHERE id = ${id(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Contact not found");
      return json({ ok: true });
    },
    "POST contacts/:id/notes": async (ctx, req, p) => {
      requireWrite(ctx);
      const contact = await requireContact(ctx, p.id);
      const b = await readJson(req, NoteBody);
      await ctx.sql`INSERT INTO crm_notes (business_id, contact_id, body, author) VALUES (${ctx.businessId}, ${contact.id}, ${b.body}, ${ctx.userId})`;
      await touch(ctx, contact.id);
      return json({ timeline: await timeline(ctx, contact.id) }, 201);
    },

    /* ---- opportunities ---- */
    "GET opportunities": async (ctx, req) => {
      const p = params(req);
      const stage = p.get("stage") ?? undefined;
      const contactId = p.get("contactId") ?? undefined;
      if (stage && !(STAGES as readonly string[]).includes(stage)) throw new HttpError(400, "stage: unknown stage");
      if (contactId && !UUID_RE.test(contactId)) throw new HttpError(400, "contactId: invalid id");
      return json({ opportunities: await listOpportunities(ctx, { stage, contactId }) });
    },
    "POST opportunities": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, CreateOpp);
      const contact = await requireContact(ctx, b.contactId);
      const stage = b.stage ?? "lead";
      if (stage === "lost" && !b.lostReason) throw new HttpError(400, "lostReason: say why the opportunity was lost");
      const oppId = await createOpportunityRow(ctx, { contactId: contact.id, title: b.title!, valueCents: b.valueCents ?? 0, stage, expectedClose: b.expectedClose ?? null, owner: b.owner ?? "", lostReason: b.lostReason ?? "" });
      return json({ opportunity: await getOpportunity(ctx, oppId) }, 201);
    },
    "GET opportunities/:id": async (ctx, _req, p) => {
      const opportunity = await requireOpportunity(ctx, p.id);
      return json({ opportunity, timeline: await timeline(ctx, opportunity.contactId, opportunity.id) });
    },
    "PATCH opportunities/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const cur = await requireOpportunity(ctx, p.id);
      const b = await readJson(req, PatchOpp);
      const now = new Date();
      await ctx.sql`
        UPDATE crm_opportunities SET title = ${b.title ?? cur.title}, value_cents = ${b.valueCents ?? cur.valueCents},
          expected_close = ${b.expectedClose === undefined ? cur.expectedClose : b.expectedClose}, owner = ${b.owner ?? cur.owner},
          lost_reason = ${cur.stage === "lost" ? (b.lostReason ?? cur.lostReason) : cur.lostReason}, updated_at = ${now}, last_activity_at = ${now}
        WHERE id = ${cur.id} AND business_id = ${ctx.businessId}`;
      await touch(ctx, cur.contactId, undefined, now);
      return json({ opportunity: await getOpportunity(ctx, cur.id) });
    },
    "POST opportunities/:id/stage": async (ctx, req, p) => {
      requireWrite(ctx);
      const b = await readJson(req, StageBody);
      return json({ opportunity: await changeStage(ctx, p.id, b.stage, b.lostReason) });
    },
    "POST opportunities/:id/notes": async (ctx, req, p) => {
      requireWrite(ctx);
      const opp = await requireOpportunity(ctx, p.id);
      const b = await readJson(req, NoteBody);
      await ctx.sql`INSERT INTO crm_notes (business_id, contact_id, opportunity_id, body, author) VALUES (${ctx.businessId}, ${opp.contactId}, ${opp.id}, ${b.body}, ${ctx.userId})`;
      await touch(ctx, opp.contactId, opp.id);
      return json({ timeline: await timeline(ctx, opp.contactId, opp.id) }, 201);
    },
    "DELETE opportunities/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM crm_opportunities WHERE id = ${id(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Opportunity not found");
      return json({ ok: true });
    },

    /* ---- pipeline and follow-up ---- */
    "GET pipeline": async (ctx, req) => json(await pipeline(ctx, new Date(), staleDaysOf(req))),
    "GET stale": async (ctx, req) => {
      const days = staleDaysOf(req);
      const now = new Date();
      const [opportunities, contacts] = await Promise.all([staleOpportunities(ctx, now, days), staleLeadContacts(ctx, now, days)]);
      return json({ days, opportunities, contacts });
    },
  }),

  async Page({ ctx, path }) {
    const [section, rest] = path;
    const nav = (
      <nav aria-label="CRM sections" className="mb-5 flex gap-2 text-sm">
        {[["Contacts", "/app/t/crm", !section || section === "contacts"], ["Pipeline", "/app/t/crm/pipeline", section === "pipeline" || section === "opportunities"]].map(([label, href, on]) => (
          <a key={String(href)} href={String(href)} aria-current={on ? "page" : undefined} className={`rounded-lg px-3 py-1.5 ${on ? "bg-slate-800 text-white" : "text-slate-400 hover:text-white"}`}>{String(label)}</a>
        ))}
      </nav>
    );
    let body;
    if (!section) {
      body = <ContactsView initial={await listContacts(ctx)} canWrite={ctx.canWrite} />;
    } else if (section === "contacts" && rest) {
      const contact = await getContact(ctx, rest);
      body = contact
        ? <ContactDetail contact={contact} opportunities={await listOpportunities(ctx, { contactId: contact.id })} timeline={await timeline(ctx, contact.id)} canWrite={ctx.canWrite} />
        : <p className="text-slate-400">That contact was not found.</p>;
    } else if (section === "pipeline") {
      body = <PipelineView initial={await pipeline(ctx)} canWrite={ctx.canWrite} />;
    } else if (section === "opportunities" && rest) {
      const opp = await getOpportunity(ctx, rest);
      body = opp
        ? <OpportunityDetail opportunity={opp} timeline={await timeline(ctx, opp.contactId, opp.id)} canWrite={ctx.canWrite} />
        : <p className="text-slate-400">That opportunity was not found.</p>;
    } else {
      body = <p className="text-slate-400">Page not found.</p>;
    }
    return (
      <div className="mx-auto max-w-6xl p-4 text-slate-100">
        {nav}
        {body}
      </div>
    );
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const now = new Date();
    const [past, stale] = await Promise.all([pastCloseOpportunities(ctx, now), staleOpportunities(ctx, now, DEFAULT_STALE_DAYS)]);
    const items: AttentionItem[] = past.map((o) => ({
      id: `crm-pastclose-${o.id}`,
      title: `Expected close date passed: ${o.title}`,
      detail: `Expected ${o.expectedClose}, still in ${o.stage.replace("_", " ")}${o.valueCents ? ` (${formatUsd(o.valueCents)})` : ""}. Update the date or move the deal.`,
      severity: "review",
      href: `/app/t/crm/opportunities/${o.id}`,
      dueDate: o.expectedClose ?? undefined,
    }));
    const flagged = new Set(past.map((o) => o.id));
    for (const o of stale) {
      if (flagged.has(o.id)) continue;
      items.push({
        id: `crm-stale-${o.id}`,
        title: `No activity for ${daysBetween(o.lastActivityAt, now)} days: ${o.title}`,
        detail: "Follow up, add a note, or close it out.",
        severity: "review",
        href: `/app/t/crm/opportunities/${o.id}`,
      });
    }
    if (items.length > 10) {
      const more = items.length - 9;
      return [...items.slice(0, 9), { id: "crm-more", title: `${more} more deals need follow-up`, severity: "review", href: "/app/t/crm/pipeline" }];
    }
    return items;
  },

  async describe(ctx) {
    const f = await tool.facts!(ctx);
    if (!f.contactCount) return "";
    const bits = [`${f.contactCount} contacts (${f.customerCount} customers).`];
    bits.push(
      f.openOpportunities
        ? `${f.openOpportunities} open opportunities worth ${formatUsd(f.pipelineValueCents as number)}.`
        : "No open opportunities.",
    );
    if (f.wonLast90DaysCents) bits.push(`Won ${formatUsd(f.wonLast90DaysCents as number)} in the last 90 days.`);
    if (f.staleCount) bits.push(`${f.staleCount} contacts or deals have had no activity in ${DEFAULT_STALE_DAYS}+ days.`);
    bits.push("No documented follow-up process.");
    return bits.join(" ");
  },

  async resolve(ctx, rid) {
    if (!UUID_RE.test(rid)) return null;
    const c = await getContact(ctx, rid);
    if (c) return { title: c.company ? `${c.name} (${c.company})` : c.name, href: `/app/t/crm/contacts/${c.id}` };
    const o = await getOpportunity(ctx, rid);
    return o ? { title: `${o.title} (${o.contactName})`, href: `/app/t/crm/opportunities/${o.id}` } : null;
  },

  async search(ctx, query, limit) {
    const like = likePattern(query);
    const [contacts, opps] = await Promise.all([
      ctx.sql<{ id: string; name: string; company: string; type: string }[]>`
        SELECT id, name, company, type FROM crm_contacts
        WHERE business_id = ${ctx.businessId} AND (name ILIKE ${like} OR company ILIKE ${like} OR email ILIKE ${like} OR notes ILIKE ${like})
        ORDER BY lower(name) LIMIT ${limit}`,
      ctx.sql<{ id: string; title: string; stage: string; contact_name: string }[]>`
        SELECT o.id, o.title, o.stage, c.name AS contact_name FROM crm_opportunities o JOIN crm_contacts c ON c.id = o.contact_id
        WHERE o.business_id = ${ctx.businessId} AND o.title ILIKE ${like} ORDER BY o.updated_at DESC LIMIT ${limit}`,
    ]);
    const hits: SearchHit[] = [
      ...contacts.map((c) => ({ id: c.id, title: c.name, snippet: [c.type, c.company].filter(Boolean).join(", "), href: `/app/t/crm/contacts/${c.id}` })),
      ...opps.map((o) => ({ id: o.id, title: o.title, snippet: `${o.stage.replace("_", " ")}, ${o.contact_name}`, href: `/app/t/crm/opportunities/${o.id}` })),
    ];
    return hits.slice(0, limit);
  },

  async facts(ctx) {
    const now = new Date();
    const open = [...OPEN_STAGES];
    const [[c], [o], stale, leads] = await Promise.all([
      ctx.sql<{ total: string; customers: string }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE type = 'customer') AS customers FROM crm_contacts WHERE business_id = ${ctx.businessId}`,
      ctx.sql<{ open: string; pipeline: string; won: string }[]>`
        SELECT count(*) FILTER (WHERE stage = ANY (${open}::text[])) AS open,
               COALESCE(sum(value_cents) FILTER (WHERE stage = ANY (${open}::text[])), 0) AS pipeline,
               COALESCE(sum(value_cents) FILTER (WHERE stage = 'won' AND closed_at >= ${new Date(now.getTime() - 90 * DAY_MS)}), 0) AS won
        FROM crm_opportunities WHERE business_id = ${ctx.businessId}`,
      staleOpportunities(ctx, now),
      staleLeadContacts(ctx, now),
    ]);
    return {
      contactCount: Number(c.total),
      customerCount: Number(c.customers),
      openOpportunities: Number(o.open),
      pipelineValueCents: Number(o.pipeline),
      wonLast90DaysCents: Number(o.won),
      staleCount: stale.length + leads.length,
      hasFollowUpProcess: false,
    };
  },
};
