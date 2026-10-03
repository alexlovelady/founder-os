"use client";
import { useState } from "react";
import { monthLabel, type FinanceMonth } from "../insights";
import { breakEven, HIRE_NOTE, hireCompare, pricing, runway, TAX_NOTE, taxReserve, type Kind } from "../calc";

export interface Saved { id: string; kind: Kind; name: string; inputs: unknown; results: unknown; createdAt: string }

const usd = (n: number | null | undefined) => (n == null ? "n/a" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }));

interface FieldDef { key: string; label: string; help?: string; kind?: "money" | "pct" | "number" }
interface Calc {
  kind: Kind;
  title: string;
  blurb: string;
  fields: FieldDef[];
  defaults: Record<string, number>;
  show: (inputs: Record<string, number>) => { label: string; value: string; big?: boolean }[];
  note?: string;
}

const CALCS: Calc[] = [
  {
    kind: "runway", title: "Runway", blurb: "How many months your cash lasts at the current pace.",
    fields: [
      { key: "cash", label: "Cash on hand" }, { key: "monthlyRecurringRevenue", label: "Monthly recurring revenue" },
      { key: "otherMonthlyRevenue", label: "Other monthly revenue" }, { key: "monthlyExpenses", label: "Monthly expenses" },
    ],
    defaults: { cash: 0, monthlyRecurringRevenue: 0, otherMonthlyRevenue: 0, monthlyExpenses: 0 },
    show: (i) => {
      const r = runway(i as never);
      return [
        { label: "Monthly revenue", value: usd(r.monthlyRevenue) },
        { label: r.profitable ? "Monthly surplus" : "Net burn per month", value: usd(Math.abs(r.netBurn)) },
        { label: "Runway", value: r.profitable ? "Not burning cash" : `${r.runwayMonths} months`, big: true },
      ];
    },
  },
  {
    kind: "break_even", title: "Break-even", blurb: "How many sales cover your fixed costs.",
    fields: [{ key: "fixedExpenses", label: "Fixed expenses per month" }, { key: "variableCostPerSale", label: "Cost of each sale" }, { key: "pricePerSale", label: "Price of each sale" }],
    defaults: { fixedExpenses: 0, variableCostPerSale: 0, pricePerSale: 0 },
    show: (i) => {
      const r = breakEven(i as never);
      if (r.breakEvenSales == null) return [{ label: "Result", value: r.reason ?? "Cannot break even", big: true }];
      return [
        { label: "Earned per sale after its cost", value: usd(r.contributionPerSale) },
        { label: "Margin", value: `${r.contributionMarginPct}%` },
        { label: "Sales needed per month", value: String(r.breakEvenSales), big: true },
        { label: "Revenue needed", value: usd(r.breakEvenRevenue) },
      ];
    },
  },
  {
    kind: "pricing", title: "Pricing", blurb: "A price that covers your costs and the margin you want, per job or product.",
    fields: [{ key: "labor", label: "Labor cost" }, { key: "materials", label: "Materials cost" }, { key: "overhead", label: "Share of overhead" }, { key: "desiredMarginPct", label: "Margin you want (%)", kind: "pct", help: "Profit as a share of the price" }],
    defaults: { labor: 0, materials: 0, overhead: 0, desiredMarginPct: 30 },
    show: (i) => {
      const r = pricing(i as never);
      if (r.targetPrice == null) return [{ label: "Result", value: r.reason ?? "", big: true }];
      return [
        { label: "Total cost", value: usd(r.totalCost) }, { label: "Lowest price (no profit)", value: usd(r.minimumPrice) },
        { label: "Target price", value: usd(r.targetPrice), big: true }, { label: "Profit at target", value: usd(r.profitAtTarget) },
      ];
    },
  },
  {
    kind: "hire_compare", title: "Contractor vs employee", blurb: "What each option costs over a year.",
    fields: [
      { key: "employeeAnnualPay", label: "Employee yearly pay" }, { key: "employerPayrollTaxPct", label: "Employer payroll taxes (%)", kind: "pct" },
      { key: "annualBenefits", label: "Benefits per year" }, { key: "otherAnnualEmployeeCosts", label: "Other employee costs per year", help: "Equipment, software, training" },
      { key: "contractorHourlyRate", label: "Contractor hourly rate" }, { key: "contractorHoursPerYear", label: "Contractor hours per year", kind: "number" },
    ],
    defaults: { employeeAnnualPay: 0, employerPayrollTaxPct: 7.65, annualBenefits: 0, otherAnnualEmployeeCosts: 0, contractorHourlyRate: 0, contractorHoursPerYear: 2000 },
    show: (i) => {
      const r = hireCompare(i as never);
      return [
        { label: "Employee, total per year", value: usd(r.employeeTotalCost) }, { label: "Contractor, total per year", value: usd(r.contractorTotalCost) },
        { label: r.cheaper === "equal" ? "Same cost" : `${r.cheaper === "contractor" ? "Contractor" : "Employee"} costs less by`, value: usd(Math.abs(r.difference)), big: true },
      ];
    },
    note: HIRE_NOTE,
  },
  {
    kind: "tax_reserve", title: "Tax set-aside", blurb: "How much of each payment to put aside for taxes.",
    fields: [{ key: "periodIncome", label: "Income for the period" }, { key: "reservePct", label: "Percent to set aside", kind: "pct", help: "You choose this. Ask your accountant what is right for you." }],
    defaults: { periodIncome: 0, reservePct: 25 },
    show: (i) => {
      const r = taxReserve(i as never);
      return [{ label: "Set aside", value: usd(r.reserveAmount), big: true }, { label: "Left to spend", value: usd(r.keepAmount) }];
    },
    note: TAX_NOTE,
  },
];

const input = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";

function Calculator({ calc, canWrite, onSaved, latest }: { calc: Calc; canWrite: boolean; onSaved: (s: Saved) => void; latest?: FinanceMonth | null }) {
  const [v, setV] = useState<Record<string, number>>(calc.defaults);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Prefill the runway form from the latest entered month. Revenue goes in "other" because the entered figure is not split into recurring and other.
  function useLatest() {
    if (!latest) return;
    setV({
      ...v,
      monthlyRecurringRevenue: 0,
      otherMonthlyRevenue: latest.revenueCents / 100,
      monthlyExpenses: latest.expensesCents / 100,
      ...(latest.cashEndCents != null ? { cash: Math.max(0, latest.cashEndCents / 100) } : {}),
    });
    setMsg(`Filled from ${monthLabel(latest.month)} (entered by you).${latest.cashEndCents == null ? " That month has no cash balance, so cash was not changed." : ""} Revenue is in the other revenue field; split it if you know the recurring part.`);
  }

  async function save() {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await fetch("/api/tools/finance/calculations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: calc.kind, name, inputs: v }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not save");
      onSaved(d.calculation);
      setName("");
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 rounded-xl border border-slate-800 bg-slate-900 p-5 md:grid-cols-2">
      <div className="space-y-3">
        <p className="text-sm text-slate-400">{calc.blurb}</p>
        {calc.kind === "runway" && latest && (
          <button type="button" onClick={useLatest} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-100">Use my latest figures ({monthLabel(latest.month)})</button>
        )}
        {calc.fields.map((f) => (
          <label key={f.key} className="block text-sm text-slate-300">
            {f.label}
            <input className={input} type="number" min={0} step="any" inputMode="decimal" value={Number.isFinite(v[f.key]) ? v[f.key] : ""} onChange={(e) => setV({ ...v, [f.key]: e.target.value === "" ? 0 : Number(e.target.value) })} />
            {f.help && <span className="text-xs text-slate-500">{f.help}</span>}
          </label>
        ))}
      </div>
      <div className="space-y-3">
        <dl className="space-y-2">
          {calc.show(v).map((r) => (
            <div key={r.label} className={`rounded-lg bg-slate-950 p-3 ${r.big ? "border border-slate-600" : ""}`}>
              <dt className="text-xs text-slate-400">{r.label}</dt>
              <dd className={r.big ? "text-xl font-semibold" : "text-sm"}>{r.value}</dd>
            </div>
          ))}
        </dl>
        {calc.note && <p className="text-xs text-slate-500">{calc.note}</p>}
        {canWrite && (
          <div className="flex gap-2">
            <input className={input.replace("mt-1 ", "")} placeholder="Name this to save it" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <button disabled={busy || !name.trim()} onClick={save} className="shrink-0 rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-50">Save</button>
          </div>
        )}
        {msg && <p className="text-xs text-slate-400" role="status">{msg}</p>}
      </div>
    </div>
  );
}

export default function Calculators({ initial, canWrite, latest }: { initial: Saved[]; canWrite: boolean; latest?: FinanceMonth | null }) {
  const [tab, setTab] = useState<Kind>("runway");
  const [saved, setSaved] = useState(initial);
  const calc = CALCS.find((c) => c.kind === tab)!;

  async function remove(id: string) {
    const r = await fetch(`/api/tools/finance/calculations/${id}`, { method: "DELETE" });
    if (r.ok) setSaved(saved.filter((s) => s.id !== id));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" role="tablist">
        {CALCS.map((c) => (
          <button key={c.kind} role="tab" aria-selected={tab === c.kind} onClick={() => setTab(c.kind)}
            className={`rounded-full border px-3 py-1 text-sm ${tab === c.kind ? "border-slate-100 bg-slate-100 text-slate-900" : "border-slate-700 text-slate-300"}`}>
            {c.title}
          </button>
        ))}
      </div>
      <Calculator key={tab} calc={calc} canWrite={canWrite} latest={latest} onSaved={(s) => setSaved([s, ...saved])} />
      <section>
        <h2 className="mb-2 font-medium">Saved calculations</h2>
        {saved.length === 0 ? <p className="text-sm text-slate-500">Nothing saved yet.</p> : (
          <ul className="space-y-2">
            {saved.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-sm">
                <span><span className="text-slate-400">{CALCS.find((c) => c.kind === s.kind)?.title}</span> · {s.name}<span className="ml-2 text-xs text-slate-500">{new Date(s.createdAt).toLocaleDateString()}</span></span>
                {canWrite && <button onClick={() => remove(s.id)} className="text-xs text-slate-400 underline">Delete</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-slate-500">Financial tools give estimates and general business information. They do not replace an accountant, tax professional, or financial adviser.</p>
    </div>
  );
}
