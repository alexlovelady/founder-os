/**
 * Actions the Ask FounderOS assistant may propose for Finance. A person confirms each one; the model never runs them.
 * record_month goes through the tool's own PUT months/:month handler, so its validation applies unchanged.
 */
import { z } from "zod";
import { callToolApi, requireWrite, type ToolAction, type ToolContext, type ToolDef } from "@founderos/sdk";
import { BREAKDOWN_TOLERANCE_CENTS, breakdownTotal, formatUsd, MAX_CENTS, monthLabel, normalizeMonth, type FinanceMonth } from "./insights";

interface MonthDto extends FinanceMonth { notes: string }

const cents = z.number().int().min(0).max(MAX_CENTS - 1);
const RecordInput = z.object({
  month: z.string().transform((s) => normalizeMonth(s)).refine((s): s is string => s !== null, "Use the first day of a month, like 2026-09-01"),
  revenueCents: cents,
  expensesCents: cents,
  cashCents: z.number().int().min(-MAX_CENTS + 1).max(MAX_CENTS - 1).optional(),
});
type RecordInput = z.infer<typeof RecordInput>;

export function financeActions(self: () => ToolDef): ToolAction[] {
  const existing = async (ctx: ToolContext, month: string): Promise<MonthDto | undefined> => {
    try {
      return (await callToolApi<{ month: MonthDto }>(self(), ctx, "GET", `months/${month}`)).month;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return undefined;
      throw e;
    }
  };

  /** The month as it would be saved. Omitted cash and notes are kept; a saved breakdown is kept only if it still fits the new expenses. */
  const merged = (old: MonthDto | undefined, i: RecordInput) => {
    const keepsBreakdown = !!old?.expenseBreakdown && breakdownTotal(old.expenseBreakdown) <= i.expensesCents + BREAKDOWN_TOLERANCE_CENTS;
    return {
      revenueCents: i.revenueCents,
      expensesCents: i.expensesCents,
      cashEndCents: i.cashCents ?? old?.cashEndCents ?? null,
      notes: old?.notes ?? "",
      expenseBreakdown: keepsBreakdown ? old!.expenseBreakdown : null,
      clearsBreakdown: !!old?.expenseBreakdown && !keepsBreakdown,
    };
  };

  const record: ToolAction<RecordInput> = {
    id: "record_month",
    description: "Record a month of revenue, expenses and (optionally) ending cash in Finance. Replaces that month if it was already entered. Figures are entered by the owner, not read from a bank.",
    input: RecordInput,
    risk: "medium",
    async preview(ctx, i) {
      const old = await existing(ctx, i.month);
      const m = merged(old, i);
      const label = monthLabel(i.month);
      const details: Record<string, string> = {
        Month: label,
        ...(old ? { "Old revenue": formatUsd(old.revenueCents), "Old expenses": formatUsd(old.expensesCents), "Old cash": formatUsd(old.cashEndCents) } : {}),
        "New revenue": formatUsd(i.revenueCents),
        "New expenses": formatUsd(i.expensesCents),
        "New cash": formatUsd(m.cashEndCents),
        Overwrites: old ? "Yes, replaces the figures already entered" : "No, this month is new",
        ...(m.clearsBreakdown ? { "Expense breakdown": "Cleared, because it no longer fits the new expenses" } : {}),
      };
      return {
        summary: old
          ? `Replace the figures already entered for ${label} (revenue ${formatUsd(old.revenueCents)} to ${formatUsd(i.revenueCents)}, expenses ${formatUsd(old.expensesCents)} to ${formatUsd(i.expensesCents)}).`
          : `Add figures for ${label}: revenue ${formatUsd(i.revenueCents)}, expenses ${formatUsd(i.expensesCents)}.`,
        details,
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = RecordInput.parse(i);
      const m = merged(await existing(ctx, v.month), v);
      await callToolApi(self(), ctx, "PUT", `months/${v.month}`, {
        revenueCents: m.revenueCents, expensesCents: m.expensesCents, cashEndCents: m.cashEndCents, notes: m.notes, expenseBreakdown: m.expenseBreakdown,
      });
      return { summary: `Recorded ${monthLabel(v.month)}: revenue ${formatUsd(v.revenueCents)}, expenses ${formatUsd(v.expensesCents)}.`, href: "/app/t/finance" };
    },
  };

  return [record];
}
