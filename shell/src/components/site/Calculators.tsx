"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { breakEven, hireCompare, pricing, runway, taxReserve } from "@/lib/site/calc";
import { NOT_ADVICE_SHORT } from "@/lib/site/config";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const toNum = (s: string) => (s.trim() === "" ? 0 : Number(s));

function Field({ id, label, value, onChange, suffix, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; suffix?: string; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-200">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none"
        />
        {suffix ? <span className="text-sm text-slate-400">{suffix}</span> : null}
      </div>
      {hint ? <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function Frame({ children, result, note }: { children: ReactNode; result: ReactNode; note?: string }) {
  return (
    <div className="space-y-6">
      <form onSubmit={(e) => e.preventDefault()} className="grid gap-4 sm:grid-cols-2">{children}</form>
      <div aria-live="polite" className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-200">{result}</div>
      {note ? <p className="text-sm text-slate-400">{note}</p> : null}
      <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
        <p className="font-semibold text-slate-100">Save this and track it in FounderOS</p>
        <p className="mt-1 text-sm text-slate-300">Nothing on this page was saved or sent anywhere. FounderOS accounts are by invitation for now.</p>
        <Link href="/login" className="mt-3 inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white">Save this and track it in FounderOS: sign in</Link>
      </div>
      <p className="text-xs text-slate-500">{NOT_ADVICE_SHORT}</p>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
    <dd className="text-xl font-semibold text-slate-50">{value}</dd>
  </div>
);

export function RunwayCalculator() {
  const [v, setV] = useState({ cash: "30000", mrr: "2000", other: "1000", exp: "8000" });
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const r = runway({ cash: toNum(v.cash), monthlyRecurringRevenue: toNum(v.mrr), otherMonthlyRevenue: toNum(v.other), monthlyExpenses: toNum(v.exp) });
  return (
    <Frame
      result={
        <dl className="grid gap-4 sm:grid-cols-3">
          <Stat label="Monthly revenue" value={usd(r.monthlyRevenue)} />
          <Stat label="Net monthly burn" value={r.profitable ? "None: revenue covers spending" : usd(r.netBurn)} />
          <Stat label="Runway" value={r.runwayMonths === null ? "Not burning cash" : `${r.runwayMonths} months`} />
        </dl>
      }
      note="Runway assumes spending and revenue stay the same. Real months vary, so treat the result as a rough guide."
    >
      <Field id="cash" label="Cash in the bank" value={v.cash} onChange={set("cash")} suffix="USD" />
      <Field id="mrr" label="Monthly recurring revenue" value={v.mrr} onChange={set("mrr")} suffix="USD" />
      <Field id="other" label="Other monthly revenue" value={v.other} onChange={set("other")} suffix="USD" />
      <Field id="exp" label="Monthly expenses" value={v.exp} onChange={set("exp")} suffix="USD" />
    </Frame>
  );
}

export function BreakEvenCalculator() {
  const [v, setV] = useState({ fixed: "1000", variable: "20", price: "50" });
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const r = breakEven({ fixedExpenses: toNum(v.fixed), variableCostPerSale: toNum(v.variable), pricePerSale: toNum(v.price) });
  return (
    <Frame
      result={
        r.breakEvenSales === null ? (
          <p>{r.reason}</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-3">
            <Stat label="Profit per sale" value={usd(r.contributionPerSale)} />
            <Stat label="Sales to break even" value={String(r.breakEvenSales)} />
            <Stat label="Revenue to break even" value={usd(r.breakEvenRevenue ?? 0)} />
          </dl>
        )
      }
    >
      <Field id="fixed" label="Fixed expenses per month" value={v.fixed} onChange={set("fixed")} suffix="USD" hint="Costs that do not change with sales: rent, software, salaries." />
      <Field id="variable" label="Cost for each sale" value={v.variable} onChange={set("variable")} suffix="USD" hint="Materials, fees and delivery for one sale." />
      <Field id="price" label="Price per sale" value={v.price} onChange={set("price")} suffix="USD" />
    </Frame>
  );
}

export function PricingCalculator() {
  const [v, setV] = useState({ labor: "50", materials: "30", overhead: "20", margin: "50" });
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const r = pricing({ labor: toNum(v.labor), materials: toNum(v.materials), overhead: toNum(v.overhead), desiredMarginPct: toNum(v.margin) });
  return (
    <Frame
      result={
        r.targetPrice === null ? (
          <p>{r.reason}</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-3">
            <Stat label="Total cost" value={usd(r.totalCost)} />
            <Stat label="Price for your margin" value={usd(r.targetPrice)} />
            <Stat label="Profit at that price" value={usd(r.profitAtTarget ?? 0)} />
          </dl>
        )
      }
      note="Margin here means profit as a share of the price. Check the result against what customers will actually pay."
    >
      <Field id="labor" label="Labor cost per unit or job" value={v.labor} onChange={set("labor")} suffix="USD" />
      <Field id="materials" label="Materials cost" value={v.materials} onChange={set("materials")} suffix="USD" />
      <Field id="overhead" label="Overhead share" value={v.overhead} onChange={set("overhead")} suffix="USD" />
      <Field id="margin" label="Margin you want" value={v.margin} onChange={set("margin")} suffix="%" />
    </Frame>
  );
}

export function ContractorVsEmployee() {
  const [v, setV] = useState({ pay: "50000", tax: "10", benefits: "5000", other: "0", rate: "40", hours: "2000" });
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const r = hireCompare({ employeeAnnualPay: toNum(v.pay), employerPayrollTaxPct: toNum(v.tax), annualBenefits: toNum(v.benefits), otherAnnualEmployeeCosts: toNum(v.other), contractorHourlyRate: toNum(v.rate), contractorHoursPerYear: toNum(v.hours) });
  const verdict = r.cheaper === "equal" ? "Both cost the same." : `On cost alone, the ${r.cheaper} is cheaper by ${usd(Math.abs(r.difference))} a year.`;
  return (
    <Frame
      result={
        <div className="space-y-3">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Stat label="Employee, total per year" value={usd(r.employeeTotalCost)} />
            <Stat label="Contractor, total per year" value={usd(r.contractorTotalCost)} />
          </dl>
          <p>{verdict}</p>
        </div>
      }
      note={r.note}
    >
      <Field id="pay" label="Employee yearly pay" value={v.pay} onChange={set("pay")} suffix="USD" />
      <Field id="tax" label="Employer payroll taxes" value={v.tax} onChange={set("tax")} suffix="%" hint="Your estimate as a percent of pay." />
      <Field id="benefits" label="Employee benefits per year" value={v.benefits} onChange={set("benefits")} suffix="USD" />
      <Field id="other" label="Other employee costs per year" value={v.other} onChange={set("other")} suffix="USD" hint="Equipment, software, training." />
      <Field id="rate" label="Contractor hourly rate" value={v.rate} onChange={set("rate")} suffix="USD" />
      <Field id="hours" label="Contractor hours per year" value={v.hours} onChange={set("hours")} suffix="hours" />
    </Frame>
  );
}

export function TaxReserveCalculator() {
  const [v, setV] = useState({ income: "5000", pct: "25" });
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const r = taxReserve({ periodIncome: toNum(v.income), reservePct: toNum(v.pct) });
  return (
    <Frame
      result={
        <dl className="grid gap-4 sm:grid-cols-2">
          <Stat label="Set aside" value={usd(r.reserveAmount)} />
          <Stat label="Left to spend" value={usd(r.keepAmount)} />
        </dl>
      }
      note={r.note}
    >
      <Field id="income" label="Income received this period" value={v.income} onChange={set("income")} suffix="USD" />
      <Field id="pct" label="Percent to set aside" value={v.pct} onChange={set("pct")} suffix="%" hint="You choose this. Ask your accountant what is right for you." />
    </Frame>
  );
}
