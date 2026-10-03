import type { ItemDto, SummaryDto } from "./types";

/** Counts and the next deadline across a checklist. Pure, so facts, describe and the UI always agree. */
export function summarize(items: Pick<ItemDto, "status" | "dueState" | "dueDate" | "category">[]): SummaryDto {
  const count = (s: string) => items.filter((i) => i.status === s).length;
  const open = items.filter((i) => i.status === "missing" || i.status === "attention");
  const dated = open.filter((i) => i.dueDate).map((i) => i.dueDate as string).sort();
  return {
    total: items.length,
    complete: count("complete"),
    attention: count("attention"),
    missing: count("missing"),
    notApplicable: count("not_applicable"),
    open: open.length,
    overdue: items.filter((i) => i.dueState === "overdue").length,
    dueSoon: items.filter((i) => i.dueState === "soon").length,
    nextDueDate: dated.find((d) => items.some((i) => i.dueDate === d && i.dueState !== "overdue")) ?? null,
    categoriesMissing: [...new Set(items.filter((i) => i.status === "missing").map((i) => i.category))].sort(),
  };
}
