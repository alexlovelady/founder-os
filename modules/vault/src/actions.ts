/**
 * Actions the Ask FounderOS assistant may propose for the document vault. A person confirms each one; the model never runs them.
 * Only metadata (expiration date, tags). It never reads, changes or deletes a file.
 */
import { z } from "zod";
import { callToolApi, clipText, HttpError, requireWrite, UUID_RE, type ActionPreview, type ToolAction, type ToolContext, type ToolDef } from "@founderos/sdk";

const id = z.string().regex(UUID_RE, "Not a valid id");
const isDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
interface DocDto { id: string; name: string; tags: string[]; expirationDate: string | null }
const href = (docId: string) => `/app/t/vault/d/${docId}`;
const normTag = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

export function vaultActions(self: () => ToolDef): ToolAction[] {
  const getDoc = async (ctx: ToolContext, docId: string): Promise<DocDto> => (await callToolApi<{ document: DocDto }>(self(), ctx, "GET", `documents/${docId}`)).document;

  const ExpInput = z.object({ documentId: id, expirationDate: z.string().refine(isDate, "Use a date like 2026-12-31").nullable() });
  const setExp: ToolAction<z.infer<typeof ExpInput>> = {
    id: "set_document_expiration",
    description: "Set or clear the expiration date of a document in the vault (expirationDate as YYYY-MM-DD, or null to clear).",
    input: ExpInput,
    risk: "low",
    async preview(ctx, i): Promise<ActionPreview> {
      const d = await getDoc(ctx, i.documentId);
      return {
        summary: i.expirationDate ? `Set the expiration of "${clipText(d.name, 120)}" to ${i.expirationDate} (now: ${d.expirationDate ?? "none"}).` : `Clear the expiration date of "${clipText(d.name, 120)}" (now: ${d.expirationDate ?? "none"}).`,
        details: { Document: d.name, "Old expiration": d.expirationDate ?? "none", "New expiration": i.expirationDate ?? "none" },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = ExpInput.parse(i);
      const r = await callToolApi<{ document: DocDto }>(self(), ctx, "PATCH", `documents/${v.documentId}`, { expirationDate: v.expirationDate });
      return { summary: r.document.expirationDate ? `"${clipText(r.document.name, 120)}" now expires ${r.document.expirationDate}.` : `Cleared the expiration date of "${clipText(r.document.name, 120)}".`, href: href(r.document.id) };
    },
  };

  const TagInput = z.object({ documentId: id, tag: z.string().trim().min(1).max(40) });
  const addTag: ToolAction<z.infer<typeof TagInput>> = {
    id: "add_document_tag",
    description: "Add one tag to a document in the vault (existing tags are kept).",
    input: TagInput,
    risk: "low",
    async preview(ctx, i): Promise<ActionPreview> {
      const d = await getDoc(ctx, i.documentId);
      const tag = normTag(i.tag);
      if (d.tags.includes(tag)) return { summary: `"${clipText(d.name, 120)}" already has the tag "${tag}"; nothing would change.`, details: { Document: d.name } };
      if (d.tags.length >= 20) throw new HttpError(400, "This document already has the maximum of 20 tags");
      return { summary: `Add the tag "${tag}" to "${clipText(d.name, 120)}".`, details: { Document: d.name, "Current tags": d.tags.join(", ") || "none", "New tag": tag } };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = TagInput.parse(i);
      const d = await getDoc(ctx, v.documentId);
      const tag = normTag(v.tag);
      if (d.tags.includes(tag)) return { summary: `"${clipText(d.name, 120)}" already has the tag "${tag}".`, href: href(d.id) };
      if (d.tags.length >= 20) throw new HttpError(400, "This document already has the maximum of 20 tags");
      const r = await callToolApi<{ document: DocDto }>(self(), ctx, "PATCH", `documents/${v.documentId}`, { tags: [...d.tags, tag] });
      return { summary: `Added the tag "${tag}" to "${clipText(r.document.name, 120)}".`, href: href(r.document.id) };
    },
  };

  return [setExp, addTag];
}
