"use client";
import { useMemo, useState } from "react";
import { breakdownTotal, computeInsights, currentMonth, EXPENSE_CATEGORIES, formatUsd, monthLabel, SOURCE_LABEL, type FinanceMonth } from "../insights";
import { CashChart, RevenueExpensesChart } from "./Chart";

const field = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";
const toCents = (s: string) => Math.round(Number(s) * 100);

interface Form { month: string; revenue: string; expenses: string; cash: string; notes: string; breakdown: Record<string, string> }
const blank = (): Form => ({ month: currentMonth().slice(0, 7), revenue: "", expenses: "", cash: "", notes: "", breakdown: {} });

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default function Monthly({ months, onChange, canWrite }: { months: FinanceMonth[]; onChange: (m: FinanceMonth[]) => void; canWrite: boolean }) {
  const ins = useMemo(() => computeInsights(months), [months]);
  const [form, setForm] = useState<Form>(blank);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  const edit = (m: FinanceMonth) => {
    setForm({
      month: m.month.slice(0, 7), revenue: String(m.revenueCents / 100), expenses: String(m.expensesCents / 100),
      cash: m.cashEndCents == null ? "" : String(m.cashEndCents / 100), notes: m.notes ?? "",
      breakdown: Object.fromEntries(Object.entries(m.expenseBreakdown ?? {}).map(([k, v]) => [k, String((v as number) / 100)])),
    });
    setOpen(true);
    setMsg(undefined);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    try {
      const entries = Object.entries(form.breakdown).filter(([, v]) => v !== "");
      const body = {
        revenueCents: toCents(form.revenue), expensesCents: toCents(form.expenses),
        cashEndCents: form.cash === "" ? null : toCents(form.cash), notes: form.notes,
        expenseBreakdown: entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, toCents(v)])) : null,
      };
      const month = `${form.month}-01`;
      const r = await fetch(`/api/tools/finance/months/${month}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not save");
      onChange([...months.filter((m) => m.month !== month), d.month as FinanceMonth].sort((a, b) => (a.month < b.month ? -1 : 1)).slice(-24));
      setForm(blank());
      setOpen(false);
      setMsg(`Saved ${monthLabel(month)}.`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: FinanceMonth) {
    if (!window.confirm(`Delete the figures for ${monthLabel(m.month)}?`)) return;
    const r = await fetch(`/api/tools/finance/months/${m.month}`, { method: "DELETE" });
    if (r.ok) onChange(months.filter((x) => x.month !== m.month));
  }

  const bdSum = Object.values(form.breakdown).reduce((a, v) => a + (v === "" ? 0 : toCents(v)), 0);
  const bdOver = bdSum > toCents(form.expenses || "0") + 100;
  const w = ins.window;

  return (
    <div className="space-y-6">
      <p className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm text-slate-300">
        <strong>{SOURCE_LABEL}.</strong> Every number here is one you typed in. Nothing is pulled from your bank, Stripe or QuickBooks.
      </p>

      {months.length === 0 ? (
        <p className="text-sm text-slate-400">No months entered yet. Add last month&apos;s revenue and expenses to see trends and runway.</p>
      ) : !ins.enoughData ? (
        <p className="text-sm text-slate-400">Not enough data yet. Add at least 2 months to see averages, change over time and runway.</p>
      ) : (
        <section aria-label="Insights" className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Card label={`Average revenue (${w!.months} mo)`} value={formatUsd(w!.avgRevenueCents)} sub="per month" />
          <Card label={`Average expenses (${w!.months} mo)`} value={formatUsd(w!.avgExpensesCents)} sub="per month" />
          <Card label={w!.avgNetCents >= 0 ? "Average surplus" : "Average burn"} value={formatUsd(Math.abs(w!.avgNetCents))} sub="per month" />
          <Card label="Revenue vs last month" value={ins.revenueChange?.pct == null ? "n/a" : `${ins.revenueChange.pct > 0 ? "+" : ""}${ins.revenueChange.pct}%`} sub={ins.revenueChange?.comparedTo ? `compared with ${monthLabel(ins.revenueChange.comparedTo)}` : "needs the month right before"} />
          <Card
            label="Runway"
            value={ins.runway.status === "ok" || ins.runway.status === "cash_depleted" ? `${ins.runway.months} months` : ins.runway.status === "not_burning" ? "Not burning cash" : "n/a"}
            sub={ins.runway.basis}
          />
          <Card label="Extra revenue to break even" value={formatUsd(ins.breakEvenGapCents)} sub={ins.breakEvenGapCents === 0 ? "Revenue covers expenses" : "per month, at the recent average"} />
          {ins.largestExpense && <Card label="Largest expense" value={ins.largestExpense.category} sub={`${formatUsd(ins.largestExpense.cents)} (${ins.largestExpense.sharePct}%) in ${monthLabel(ins.largestExpense.month)}`} />}
        </section>
      )}
      {ins.freshness.stale && <p className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-200" role="status">Your latest figures are for {monthLabel(ins.latestMonth!)}, which is a while ago. Add the months since so these numbers are current.</p>}

      {months.length > 0 && (
        <section className="space-y-4">
          <RevenueExpensesChart months={months} />
          <CashChart months={months} />
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Monthly figures</h2>
          {canWrite && !open && <button onClick={() => { setForm(blank()); setOpen(true); setMsg(undefined); }} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900">Add a month</button>}
        </div>

        {open && canWrite && (
          <form onSubmit={save} className="mb-4 space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm text-slate-300">Month
                <input className={field} type="month" required max={currentMonth().slice(0, 7)} value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} />
              </label>
              <label className="block text-sm text-slate-300">Cash at the end of the month (optional)
                <input className={field} type="number" step="0.01" inputMode="decimal" value={form.cash} onChange={(e) => setForm({ ...form, cash: e.target.value })} />
              </label>
              <label className="block text-sm text-slate-300">Revenue
                <input className={field} type="number" min={0} step="0.01" inputMode="decimal" required value={form.revenue} onChange={(e) => setForm({ ...form, revenue: e.target.value })} />
              </label>
              <label className="block text-sm text-slate-300">Total expenses
                <input className={field} type="number" min={0} step="0.01" inputMode="decimal" required value={form.expenses} onChange={(e) => setForm({ ...form, expenses: e.target.value })} />
              </label>
            </div>
            <details className="text-sm text-slate-300">
              <summary className="cursor-pointer">Expense breakdown (optional)</summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                {EXPENSE_CATEGORIES.map((c) => (
                  <label key={c} className="block capitalize">{c}
                    <input className={field} type="number" min={0} step="0.01" inputMode="decimal" value={form.breakdown[c] ?? ""} onChange={(e) => setForm({ ...form, breakdown: { ...form.breakdown, [c]: e.target.value } })} />
                  </label>
                ))}
              </div>
              <p className={`mt-1 text-xs ${bdOver ? "text-amber-300" : "text-slate-500"}`}>Categories add up to {formatUsd(bdSum)}{bdOver ? ", which is more than total expenses." : "."}</p>
            </details>
            <label className="block text-sm text-slate-300">Notes (optional)
              <input className={field} maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <p className="text-xs text-slate-500">Saving a month that already exists replaces it. Enter whole dollars or dollars and cents.</p>
            <div className="flex gap-2">
              <button disabled={busy || bdOver} className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-50">Save month</button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancel</button>
            </div>
          </form>
        )}
        {msg && <p className="mb-2 text-xs text-slate-400" role="status">{msg}</p>}

        {months.length === 0 ? null : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Monthly figures entered by you</caption>
              <thead className="bg-slate-900 text-xs text-slate-400">
                <tr><th className="px-3 py-2">Month</th><th className="px-3 py-2">Revenue</th><th className="px-3 py-2">Expenses</th><th className="px-3 py-2">Net</th><th className="px-3 py-2">Cash</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {[...months].reverse().map((m) => {
                  const net = m.revenueCents - m.expensesCents;
                  return (
                    <tr key={m.month} className="border-t border-slate-800">
                      <td className="px-3 py-2">{monthLabel(m.month)}{m.expenseBreakdown && breakdownTotal(m.expenseBreakdown) > 0 && <span className="ml-1 text-xs text-slate-500">(breakdown)</span>}</td>
                      <td className="px-3 py-2">{formatUsd(m.revenueCents)}</td>
                      <td className="px-3 py-2">{formatUsd(m.expensesCents)}</td>
                      <td className={`px-3 py-2 ${net < 0 ? "text-amber-300" : ""}`}>{formatUsd(net)}</td>
                      <td className="px-3 py-2">{formatUsd(m.cashEndCents)}</td>
                      <td className="px-3 py-2 text-right">
                        {canWrite && (<><button onClick={() => edit(m)} className="mr-3 text-xs text-slate-300 underline">Edit</button><button onClick={() => remove(m)} className="text-xs text-slate-400 underline">Delete</button></>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-xs text-slate-500">These are estimates from numbers you entered, to help you decide. They do not replace an accountant, tax professional, or financial adviser.</p>
    </div>
  );
}
