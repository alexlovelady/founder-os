/**
 * Actions the Ask FounderOS assistant may propose for the CRM. A person confirms each one; the model never runs them.
 * Everything goes through the CRM's own API handler, so duplicate checks, stage history and the "lost needs a reason" rule apply unchanged.
 * Nothing here emails or messages a contact.
 */
import { z } from "zod";
import { callToolApi, clipText, requireWrite, UUID_RE, type ToolAction, type ToolContext, type ToolDef } from "@founderos/sdk";

const id = z.string().regex(UUID_RE, "Not a valid id");
const STAGES = ["lead", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as const;
const stageLabel = (s: string) => s.replace("_", " ");

interface ContactDto { id: string; name: string; company: string }
interface OppDto { id: string; title: string; stage: string; contactName: string; lostReason: string }
interface TimelineEntry { kind: string; body?: string; author: string; at: string; opportunityId: string | null }

export function crmActions(self: () => ToolDef): ToolAction[] {
  const api = <T,>(ctx: ToolContext, method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => callToolApi<T>(self(), ctx, method, path, body);

  const AddContactInput = z.object({
    name: z.string().trim().min(1).max(200),
    company: z.string().trim().max(200).optional(),
    email: z.string().trim().max(254).optional(),
    phone: z.string().trim().max(40).optional(),
    type: z.enum(["lead", "customer", "vendor", "partner"]).optional(),
    notes: z.string().max(5000).optional(),
  });
  const addContact: ToolAction<z.infer<typeof AddContactInput>> = {
    id: "add_contact",
    description: "Add a new contact (lead, customer, vendor or partner). It does not email or message them.",
    input: AddContactInput,
    risk: "low",
    async preview(ctx, i) {
      const dupes = i.email ? (await api<{ duplicates: { id: string; name: string }[] }>(ctx, "GET", `duplicates?email=${encodeURIComponent(i.email)}`)).duplicates : [];
      return {
        summary: `Add ${i.type ?? "lead"} "${clipText(i.name, 100)}"${i.company ? ` (${clipText(i.company, 80)})` : ""} to the CRM.${dupes.length ? ` A contact with this email already exists (${dupes[0].name}), so this will be refused.` : ""}`,
        details: { Name: i.name, ...(i.company ? { Company: i.company } : {}), ...(i.email ? { Email: i.email } : {}), ...(i.phone ? { Phone: i.phone } : {}), Type: i.type ?? "lead" },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = AddContactInput.parse(i);
      // The proposal key is kept in the contact's `source`, so confirming the same proposal twice finds the contact it already made.
      const marker = ctx.idempotencyKey ? `Ask FounderOS ${ctx.idempotencyKey}`.slice(0, 100) : "Ask FounderOS";
      if (ctx.idempotencyKey) {
        const found = (await api<{ contacts: (ContactDto & { source: string })[] }>(ctx, "GET", `contacts?q=${encodeURIComponent(v.name)}`)).contacts.find((c) => c.source === marker);
        if (found) return { summary: `"${clipText(found.name, 100)}" was already added.`, href: `/app/t/crm/contacts/${found.id}` };
      }
      const r = await api<{ contact: ContactDto }>(ctx, "POST", "contacts", { ...v, source: marker });
      return { summary: `Added "${clipText(r.contact.name, 100)}" to the CRM.`, href: `/app/t/crm/contacts/${r.contact.id}` };
    },
  };

  const AddNoteInput = z
    .object({ contactId: id.optional(), opportunityId: id.optional(), body: z.string().trim().min(1).max(5000) })
    .refine((v) => !!v.contactId !== !!v.opportunityId, "Give either contactId or opportunityId");
  const addNote: ToolAction<z.infer<typeof AddNoteInput>> = {
    id: "add_note",
    description: "Add a note to a contact or to an opportunity (give contactId or opportunityId, not both).",
    input: AddNoteInput,
    risk: "low",
    async preview(ctx, i) {
      const who = i.opportunityId
        ? (await api<{ opportunity: OppDto }>(ctx, "GET", `opportunities/${i.opportunityId}`)).opportunity.title
        : (await api<{ contact: ContactDto }>(ctx, "GET", `contacts/${i.contactId}`)).contact.name;
      return { summary: `Add a note to "${clipText(who, 100)}".`, details: { For: who, Note: clipText(i.body, 400) } };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = AddNoteInput.parse(i);
      const base = v.opportunityId ? `opportunities/${v.opportunityId}` : `contacts/${v.contactId}`;
      const cur = await api<{ timeline: TimelineEntry[]; contact?: ContactDto; opportunity?: OppDto & { contactId: string } }>(ctx, "GET", base);
      const href = v.opportunityId ? `/app/t/crm/opportunities/${v.opportunityId}` : `/app/t/crm/contacts/${v.contactId}`;
      // Same proposal confirmed twice: an identical note by this user in the last day means it already went in.
      if (ctx.idempotencyKey && cur.timeline.some((e) => e.kind === "note" && e.body === v.body && e.author === ctx.userId && Date.now() - Date.parse(e.at) < 86_400_000)) {
        return { summary: "That note was already added.", href };
      }
      await api(ctx, "POST", `${base}/notes`, { body: v.body });
      return { summary: "Added the note.", href };
    },
  };

  const MoveInput = z
    .object({ opportunityId: id, stage: z.enum(STAGES), lostReason: z.string().trim().max(500).optional() })
    .refine((v) => v.stage !== "lost" || !!v.lostReason, "lostReason is required when the stage is lost");
  const move: ToolAction<z.infer<typeof MoveInput>> = {
    id: "move_opportunity_stage",
    description: "Move an opportunity to another pipeline stage (lead, contacted, qualified, proposal_sent, negotiation, won, lost). A lost opportunity needs lostReason.",
    input: MoveInput,
    risk: "medium",
    async preview(ctx, i) {
      const o = (await api<{ opportunity: OppDto }>(ctx, "GET", `opportunities/${i.opportunityId}`)).opportunity;
      if (o.stage === i.stage) return { summary: `"${clipText(o.title, 100)}" is already in ${stageLabel(o.stage)}; nothing would change.`, details: { Opportunity: o.title } };
      return {
        summary: `Move "${clipText(o.title, 100)}" (${clipText(o.contactName, 60)}) from ${stageLabel(o.stage)} to ${stageLabel(i.stage)}.`,
        details: { Opportunity: o.title, From: stageLabel(o.stage), To: stageLabel(i.stage), ...(i.lostReason ? { "Reason lost": i.lostReason } : {}) },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = MoveInput.parse(i);
      const r = await api<{ opportunity: OppDto }>(ctx, "POST", `opportunities/${v.opportunityId}/stage`, { stage: v.stage, lostReason: v.lostReason });
      return { summary: `Moved "${clipText(r.opportunity.title, 100)}" to ${stageLabel(r.opportunity.stage)}.`, href: `/app/t/crm/opportunities/${r.opportunity.id}` };
    },
  };

  return [addContact, addNote, move];
}
