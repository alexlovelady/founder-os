import { Callout, NotAdvice, PageShell, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { allPlans, formatPrice, limitLines } from "@/lib/site/plans-view";

export const metadata = pageMetadata("/pricing");

export default function Pricing() {
  const plans = allPlans();
  return (
    <PageShell title="Pricing" lead="Simple monthly plans. Prices and limits below are read from the same configuration the app uses.">
      <Callout tone="warn" title="Checkout is not live yet">
        <p>You cannot subscribe or pay on this site yet. Checkout will be available once billing is enabled, and prices may change before then. Accounts are currently created by an administrator, by invitation.</p>
      </Callout>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="text-lg font-semibold text-slate-100">{p.name}</h2>
            <p className="mt-1 text-2xl font-semibold text-slate-50">{formatPrice(p)}</p>
            <p className="mt-1 text-sm text-slate-400">{p.tagline}</p>
            <ul className="mt-4 space-y-1 text-sm text-slate-300">
              {limitLines(p).map((l) => (
                <li key={l}>{l}</li>
              ))}
              {p.features.weeklyBrief ? <li>Weekly business brief</li> : null}
              {p.features.teamInvites ? <li>Team invites</li> : null}
              {p.features.dataExport ? <li>Data export</li> : null}
            </ul>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-400">Prices are in US dollars per month. AI features currently run on private hardware, so request limits apply to every plan.</p>
      <SignInCta />
      <NotAdvice />
    </PageShell>
  );
}
