"use client";
import { useState } from "react";
import Link from "next/link";
import { SEVERITY_LABEL, type Severity } from "@/lib/dashboard/logic";

export interface AttentionRow { id: string; title: string; detail?: string; severity: Severity; href?: string; dueLabel?: string }

const BADGE: Record<Severity, string> = {
  high: "bg-red-950 text-red-200 border-red-900",
  review: "bg-amber-950 text-amber-200 border-amber-900",
  info: "bg-slate-800 text-slate-300 border-slate-700",
};

const safeHref = (h?: string) => (h && h.startsWith("/") && !h.startsWith("//") ? h : undefined);

/** Needs-attention list: the top few items, with the rest behind "Show all". */
export default function AttentionList({ items, limit = 5 }: { items: AttentionRow[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  const hidden = items.length - shown.length;
  return (
    <div>
      <ul className="mt-3 space-y-3">
        {shown.map((i) => {
          const href = safeHref(i.href);
          return (
            <li key={i.id} className="rounded-lg bg-slate-950 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className={`mr-2 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${BADGE[i.severity]}`}>{SEVERITY_LABEL[i.severity]}</span>
                  <span className="text-sm font-medium">{i.title}</span>
                </div>
                {href && <Link href={href} className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs hover:bg-slate-800" aria-label={`Open: ${i.title}`}>Open</Link>}
              </div>
              {i.dueLabel && <div className="mt-1 text-xs text-slate-300">{i.dueLabel}</div>}
              {i.detail && <div className="mt-0.5 text-xs text-slate-400">{i.detail}</div>}
            </li>
          );
        })}
      </ul>
      {items.length > limit && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className="mt-3 text-xs underline">
          {all ? "Show fewer" : `Show all (${hidden} more)`}
        </button>
      )}
    </div>
  );
}
