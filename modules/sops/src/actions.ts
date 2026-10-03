/**
 * Actions the Ask FounderOS assistant may propose for SOPs and business documents. A person confirms each one; the model never runs them.
 * The assistant only ever creates a DRAFT: it is never active, and the text is AI-written, so it must be reviewed before use.
 */
import { z } from "zod";
import { callToolApi, clipText, requireWrite, type ToolAction, type ToolDef } from "@founderos/sdk";
import { DOC_KINDS } from "./templates";

const Input = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  kind: z.enum(DOC_KINDS).optional(),
});

interface DocDto { id: string; title: string; status: string; createdAt: string }

export function sopsActions(self: () => ToolDef): ToolAction[] {
  const create: ToolAction<z.infer<typeof Input>> = {
    id: "create_sop_draft",
    description: "Save a new SOP or business document as a DRAFT (title and full text in markdown). It is never made active; the user reviews and edits it first.",
    input: Input,
    risk: "low",
    async preview(_ctx, i) {
      return {
        summary: `Save a new draft "${clipText(i.title, 120)}" (${i.kind ?? "sop"}, ${i.body.length} characters). It stays a draft until you review it.`,
        details: { Title: i.title, Type: i.kind ?? "sop", Status: "draft (AI-written, review before use)", Start: clipText(i.body, 400) },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = Input.parse(i);
      if (ctx.idempotencyKey) {
        // Same proposal confirmed twice: a draft with this title made in the last day is the one the first confirm created.
        const { documents } = await callToolApi<{ documents: DocDto[] }>(self(), ctx, "GET", "documents");
        const found = documents.find((d) => d.title === v.title && d.status === "draft" && Date.now() - Date.parse(d.createdAt) < 86_400_000);
        if (found) return { summary: `The draft "${clipText(found.title, 120)}" was already saved.`, href: `/app/t/sops/${found.id}` };
      }
      const r = await callToolApi<{ document: DocDto }>(self(), ctx, "POST", "documents", { title: v.title, body: v.body, kind: v.kind ?? "sop", status: "draft" });
      return { summary: `Saved the draft "${clipText(r.document.title, 120)}". Review it before using it.`, href: `/app/t/sops/${r.document.id}` };
    },
  };
  return [create];
}
