import { redirect } from "next/navigation";
import { PLANS } from "@/config/plans";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";
import { currentUsageSummary, getBillingConfig, PAID_PLANS, type UsageLine } from "@/lib/billing";
import { ManageButton, PlanButton } from "@/components/billing/BillingActions";

export const dynamic = "force-dynamic";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const fmtNum = (n: number, unit: "MB" | null) => (unit === "MB" ? (n >= 1000 ? `${Math.round(n / 100) / 10} GB` : `${n} MB`) : n.toLocaleString("en-US"));

function Bar({ line }: { line: UsageLine }) {
  const hot = (line.percent ?? 0) >= 90;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{line.label}</span>
        <span className="text-slate-400">
          {fmtNum(line.used, line.unit)} of {line.limit === null ? "unlimited" : fmtNum(line.limit, line.unit)}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={line.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={line.label}>
        {line.percent !== null && <div className={`h-full ${hot ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${line.percent}%` }} />}
      </div>
    </div>
  );
}

export default async function Billing({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");
  const { checkout } = await searchParams;
  const cfg = getBillingConfig();
  const s = await currentUsageSummary(db(), business.id);
  const canManage = business.role === "owner" || business.role === "admin";
  const paidViaStripe = s.source === "subscription";

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      <h1 className="text-2xl font-semibold">Plan and billing</h1>

      {!cfg.enabled && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
          Billing is not enabled yet. Every business is on the Free plan for now, and paid plans cannot be bought until the owner switches billing on.
        </div>
      )}
      {checkout === "success" && cfg.enabled && (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-4 text-sm text-emerald-200">
          Thanks. Your payment is being confirmed by Stripe; your new plan appears here within a minute. Refresh if it has not changed yet.
        </div>
      )}
      {checkout === "canceled" && <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">Checkout was canceled. You have not been charged.</div>}
      {s.pastDue && (
        <div role="alert" className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
          Your last payment did not go through. Your {s.plan.name} plan stays active until {fmtDate(s.pastDue.graceEndsAt)}; update your payment method before then or the business moves to Free.
        </div>
      )}
      {s.graceExpired && (
        <div role="alert" className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
          Payment failed and the grace period has ended, so this business is on the Free plan. Update your payment method to restore your plan.
        </div>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-slate-400">Current plan</p>
            <p className="text-xl font-medium">
              {s.plan.name}
              {s.plan.priceMonthlyUsd > 0 && <span className="ml-2 text-sm font-normal text-slate-400">${s.plan.priceMonthlyUsd} a month</span>}
            </p>
            {s.source === "override" && <p className="text-xs text-slate-500">Set by a FounderOS administrator{s.overrideReason ? `: ${s.overrideReason}` : ""}.</p>}
            {paidViaStripe && s.status === "trialing" && s.currentPeriodEnd && <p className="text-xs text-slate-500">Free trial until {fmtDate(s.currentPeriodEnd)}.</p>}
            {paidViaStripe && s.status !== "trialing" && s.currentPeriodEnd && (
              <p className="text-xs text-slate-500">{s.cancelAtPeriodEnd ? `Ends on ${fmtDate(s.currentPeriodEnd)}; it will not renew.` : `Renews on ${fmtDate(s.currentPeriodEnd)}.`}</p>
            )}
          </div>
          {(s.hasStripeCustomer || paidViaStripe) && (
            <ManageButton disabled={!cfg.enabled || !canManage} reason={!cfg.enabled ? "Billing is not enabled yet." : !canManage ? "Only the owner or an admin can manage billing." : undefined} />
          )}
        </div>
        <div className="space-y-3">
          {s.usage.map((u) => (
            <Bar key={u.metric} line={u} />
          ))}
        </div>
        <p className="text-xs text-slate-500">Monthly usage counts from {fmtDate(s.periodStart)} and resets on the 1st (UTC).</p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Plans</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => {
            const current = p.id === s.plan.id;
            const paid = PAID_PLANS.find((x) => x === p.id);
            let reason: string | undefined;
            if (paid) {
              if (!cfg.enabled) reason = "Billing is not enabled yet.";
              else if (!cfg.prices[paid]) reason = "This plan is not available to buy yet.";
              else if (!canManage) reason = "Only the owner or an admin can change the plan.";
            }
            return (
              <div key={p.id} className={`flex flex-col rounded-xl border p-4 ${current ? "border-indigo-500 bg-slate-900" : "border-slate-800 bg-slate-900/60"}`}>
                <p className="font-medium">{p.name}</p>
                <p className="text-2xl font-semibold">{p.priceMonthlyUsd === 0 ? "Free" : `$${p.priceMonthlyUsd}`}{p.priceMonthlyUsd > 0 && <span className="text-sm font-normal text-slate-400"> / month</span>}</p>
                <p className="mt-1 text-sm text-slate-400">{p.tagline}</p>
                <ul className="mt-3 flex-1 list-disc space-y-1 pl-5 text-sm text-slate-300">
                  {p.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
                <div className="mt-4">
                  {current ? (
                    <p className="rounded-md bg-slate-800 px-3 py-2 text-center text-sm text-slate-300">Your current plan</p>
                  ) : paid ? (
                    paidViaStripe ? (
                      <p className="text-xs text-slate-500">Change plan with Manage subscription above.</p>
                    ) : (
                      <PlanButton plan={p.id} label={`Upgrade to ${p.name}`} disabled={Boolean(reason)} reason={reason} />
                    )
                  ) : (
                    <p className="text-xs text-slate-500">Downgrade by canceling in Manage subscription.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
