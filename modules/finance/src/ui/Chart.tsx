"use client";
/** Small SVG charts, no chart library. The month table next to them is the text version of the same numbers. */
import { formatUsd, monthLabel, type FinanceMonth } from "../insights";

const W = 640;
const H = 220;
const PAD = { l: 8, r: 8, t: 12, b: 28 };

const short = (m: string) => monthLabel(m).replace(/ \d{2}(\d{2})$/, " '$1");

export function RevenueExpensesChart({ months }: { months: FinanceMonth[] }) {
  if (months.length === 0) return null;
  const max = Math.max(1, ...months.flatMap((m) => [m.revenueCents, m.expensesCents]));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const group = innerW / months.length;
  const bar = Math.min(28, group / 2.6);
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH;
  const labelEvery = Math.ceil(months.length / 8);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Revenue and expenses for ${months.length} months, ${months[0] && short(months[0].month)} to ${short(months[months.length - 1].month)}. The table below has the numbers.`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH} className="stroke-slate-700" />
        {months.map((m, i) => {
          const cx = PAD.l + group * i + group / 2;
          return (
            <g key={m.month}>
              <rect x={cx - bar - 1} y={y(m.revenueCents)} width={bar} height={PAD.t + innerH - y(m.revenueCents)} rx={2} className="fill-emerald-400">
                <title>{`${monthLabel(m.month)} revenue ${formatUsd(m.revenueCents)}`}</title>
              </rect>
              <rect x={cx + 1} y={y(m.expensesCents)} width={bar} height={PAD.t + innerH - y(m.expensesCents)} rx={2} className="fill-amber-400">
                <title>{`${monthLabel(m.month)} expenses ${formatUsd(m.expensesCents)}`}</title>
              </rect>
              {i % labelEvery === 0 && <text x={cx} y={H - 10} textAnchor="middle" className="fill-slate-400" fontSize="11">{short(m.month)}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-4 text-xs text-slate-400">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-400" />Revenue</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />Expenses</span>
        <span>Tallest bar: {formatUsd(max)}</span>
      </figcaption>
    </figure>
  );
}

export function CashChart({ months }: { months: FinanceMonth[] }) {
  const pts = months.map((m, i) => ({ m, i })).filter((p) => p.m.cashEndCents != null);
  if (pts.length < 2) return <p className="text-xs text-slate-500">Enter the cash balance for at least 2 months to see the cash line.</p>;
  const vals = pts.map((p) => p.m.cashEndCents as number);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(1, ...vals);
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (months.length === 1 ? innerW / 2 : (innerW * (i + 0.5)) / months.length);
  const y = (v: number) => PAD.t + innerH - ((v - lo) / (hi - lo)) * innerH;
  const d = pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)} ${y(p.m.cashEndCents as number).toFixed(1)}`).join(" ");
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Cash at the end of each month, from ${formatUsd(vals[0])} to ${formatUsd(vals[vals.length - 1])}. The table below has the numbers.`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="stroke-slate-700" strokeDasharray="3 3" />
        <path d={d} fill="none" strokeWidth={2} className="stroke-sky-400" />
        {pts.map((p) => (
          <circle key={p.m.month} cx={x(p.i)} cy={y(p.m.cashEndCents as number)} r={3.5} className="fill-sky-400">
            <title>{`${monthLabel(p.m.month)} cash ${formatUsd(p.m.cashEndCents)}`}</title>
          </circle>
        ))}
        <text x={PAD.l} y={H - 10} className="fill-slate-400" fontSize="11">{short(pts[0].m.month)}</text>
        <text x={W - PAD.r} y={H - 10} textAnchor="end" className="fill-slate-400" fontSize="11">{short(pts[pts.length - 1].m.month)}</text>
      </svg>
      <figcaption className="mt-1 text-xs text-slate-400"><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-sky-400" />Cash at month end (dashed line is zero)</figcaption>
    </figure>
  );
}
