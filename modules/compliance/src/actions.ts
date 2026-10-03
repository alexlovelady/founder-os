/**
 * Actions the Ask FounderOS assistant may propose for the compliance checklist. A person confirms each one; the model never runs them.
 * Everything goes through the tool's own API handler. Marking an item complete is the user's own statement that it is done: the
 * assistant cannot verify it, and the preview says so. Nothing is filed, paid or sent.
 */
import { z } from "zod";
import { callToolApi, clipText, HttpError, requireWrite, UUID_RE, type ToolAction, type ToolContext, type ToolDef } from "@founderos/sdk";
import { CATEGORIES, isValidDate } from "./engine";
import type { ItemDto, ListDto } from "./types";

const id = z.string().regex(UUID_RE, "Not a valid id");
const dateStr = z.string().refine(isValidDate, "Use a date like 2026-12-31");
const href = (itemId: string) => `/app/t/compliance/i/${itemId}`;

export function complianceActions(self: () => ToolDef): ToolAction[] {
  const api = <T,>(ctx: ToolContext, method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => callToolApi<T>(self(), ctx, method, path, body);
  /** The tool has no single-item GET: read the list (already scoped to this business) and find the item. */
  const getItem = async (ctx: ToolContext, itemId: string): Promise<ItemDto> => {
    const item = (await api<ListDto>(ctx, "GET", "items")).items.find((i) => i.id === itemId);
    if (!item) throw new HttpError(404, "Not found");
    return item;
  };

  const CompleteInput = z.object({ itemId: id });
  const complete: ToolAction<z.infer<typeof CompleteInput>> = {
    id: "mark_item_complete",
    description: "Mark a compliance checklist item as complete. Only propose this when the user says it has been done.",
    input: CompleteInput,
    risk: "medium",
    async preview(ctx, i) {
      const it = await getItem(ctx, i.itemId);
      if (it.status === "complete") return { summary: `"${clipText(it.title, 120)}" is already complete; nothing would change.`, details: { Item: it.title } };
      return {
        summary: `Mark "${clipText(it.title, 120)}" as complete.`,
        details: { Item: it.title, "Now": it.status.replace("_", " "), ...(it.dueDate ? { Due: it.dueDate } : {}), Note: "This records your confirmation that it was done. FounderOS does not check it." },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = CompleteInput.parse(i);
      const r = await api<{ item: ItemDto }>(ctx, "PATCH", `items/${v.itemId}`, { status: "complete" });
      return { summary: `Marked "${clipText(r.item.title, 120)}" as complete.`, href: href(r.item.id) };
    },
  };

  const DueInput = z.object({ itemId: id, dueDate: dateStr });
  const setDue: ToolAction<z.infer<typeof DueInput>> = {
    id: "set_item_due_date",
    description: "Change the due date of a compliance checklist item.",
    input: DueInput,
    risk: "medium",
    async preview(ctx, i) {
      const it = await getItem(ctx, i.itemId);
      return {
        summary: `Change the due date of "${clipText(it.title, 120)}" from ${it.dueDate ?? "none"} to ${i.dueDate}.`,
        details: { Item: it.title, "Old due date": it.dueDate ?? "none", "New due date": i.dueDate, Note: "Check the date against the official source." },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = DueInput.parse(i);
      const r = await api<{ item: ItemDto }>(ctx, "PATCH", `items/${v.itemId}`, { dueDate: v.dueDate });
      return { summary: `"${clipText(r.item.title, 120)}" is now due ${r.item.dueDate}.`, href: href(r.item.id) };
    },
  };

  const AddInput = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    category: z.enum(CATEGORIES).optional(),
    dueDate: dateStr.optional(),
  });
  const MARK = (key?: string) => (key ? `Added by Ask FounderOS (ref ${key})` : "Added by Ask FounderOS");
  const add: ToolAction<z.infer<typeof AddInput>> = {
    id: "add_custom_item",
    description: "Add your own item to the compliance checklist (it starts as not yet confirmed).",
    input: AddInput,
    risk: "low",
    async preview(_ctx, i) {
      return {
        summary: `Add "${clipText(i.title, 120)}" to the compliance checklist${i.dueDate ? ` due ${i.dueDate}` : ""}.`,
        details: { Title: i.title, Category: i.category ?? "other", ...(i.dueDate ? { Due: i.dueDate } : {}), ...(i.description ? { Description: clipText(i.description, 300) } : {}) },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = AddInput.parse(i);
      const notes = MARK(ctx.idempotencyKey);
      if (ctx.idempotencyKey) {
        const found = (await api<ListDto>(ctx, "GET", "items")).items.find((x) => x.custom && x.notes === notes);
        if (found) return { summary: `"${clipText(found.title, 120)}" was already added.`, href: href(found.id) };
      }
      const r = await api<{ item: ItemDto }>(ctx, "POST", "items", { ...v, notes });
      return { summary: `Added "${clipText(r.item.title, 120)}" to the compliance checklist.`, href: href(r.item.id) };
    },
  };

  return [complete, setDue, add];
}
