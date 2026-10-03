"use client";
import { useState } from "react";
import type { FinanceMonth } from "../insights";
import Calculators, { type Saved } from "./Calculators";
import Monthly from "./Monthly";

export default function FinanceApp({ initial, initialMonths, canWrite }: { initial: Saved[]; initialMonths: FinanceMonth[]; canWrite: boolean }) {
  const [tab, setTab] = useState<"calculators" | "monthly">("calculators");
  const [months, setMonths] = useState(initialMonths);
  const latest = months.length ? months[months.length - 1] : null;
  const tabs = [["calculators", "Calculators"], ["monthly", "Monthly figures"]] as const;
  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-slate-800 pb-3" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === id ? "bg-slate-100 text-slate-900" : "text-slate-300 hover:bg-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>
      {/* Both stay mounted so a saved calculation or an unsaved form is not lost when switching tabs. */}
      <div hidden={tab !== "calculators"}><Calculators initial={initial} canWrite={canWrite} latest={latest} /></div>
      <div hidden={tab !== "monthly"}><Monthly months={months} onChange={setMonths} canWrite={canWrite} /></div>
    </div>
  );
}
