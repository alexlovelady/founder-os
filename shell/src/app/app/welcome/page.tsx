import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { buildContext } from "@/lib/tools/context";
import { gettingStarted, HEALTH_COOKIE } from "@/lib/dashboard/logic";
import { MarkWelcomeSeen, StepLink } from "@/components/dashboard/StepLink";

export const dynamic = "force-dynamic";

export default async function Welcome() {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");
  const ctx = await buildContext(session);
  const facts = ctx ? await ctx.facts().catch(() => ({})) : {};
  const jar = await cookies();
  const progress = gettingStarted(facts, {
    healthVisited: jar.get(HEALTH_COOKIE)?.value === "1",
    askedBefore: Number((facts as Record<string, Record<string, unknown>>).founderai?.conversationCount ?? 0) > 0,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <MarkWelcomeSeen />
      <div>
        <h1 className="text-2xl font-semibold">We created your business workspace</h1>
        <p className="mt-1 text-slate-400">{business.name} is set up. Four quick steps get the most out of it. You can skip any of them and come back from the dashboard.</p>
      </div>
      <ol className="space-y-3" aria-label="Getting started steps">
        {progress.steps.map((s, i) => (
          <li key={s.key} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <span aria-hidden className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${s.done ? "bg-emerald-900 text-emerald-200" : "bg-slate-800 text-slate-300"}`}>{s.done ? "✓" : i + 1}</span>
              <div>
                <h2 className="font-medium">{s.title}{s.done && <span className="ml-2 text-xs font-normal text-emerald-300">Done</span>}</h2>
                <p className="mt-0.5 text-sm text-slate-400">{s.detail}</p>
              </div>
            </div>
            <StepLink href={s.href} flag={s.key === "health"} className="shrink-0 rounded-lg bg-slate-100 px-4 py-2 text-center text-sm font-medium text-slate-900">{s.cta}</StepLink>
          </li>
        ))}
      </ol>
      <Link href="/app/dashboard" className="inline-block text-sm text-slate-300 underline">Skip for now and go to the dashboard</Link>
    </div>
  );
}
