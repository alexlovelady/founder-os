import Link from "next/link";
import type { ReactNode } from "react";
import { NOT_ADVICE_SHORT, SITE } from "@/lib/site/config";

/** Page wrapper: one h1, optional lead paragraph. Pages put sections inside it. */
export function PageShell({ title, lead, children, narrow }: { title: string; lead?: string; children: ReactNode; narrow?: boolean }) {
  return (
    <main id="main" className={`mx-auto w-full px-4 py-10 sm:py-14 ${narrow ? "max-w-3xl" : "max-w-5xl"}`}>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">{title}</h1>
      {lead ? <p className="mt-4 max-w-2xl text-lg text-slate-300">{lead}</p> : null}
      <div className="mt-8 space-y-10">{children}</div>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
      <div className="mt-3 space-y-3 text-slate-300">{children}</div>
    </section>
  );
}

export function Callout({ title, children, tone = "info" }: { title?: string; children: ReactNode; tone?: "info" | "warn" }) {
  const cls = tone === "warn" ? "border-amber-700/60 bg-amber-950/30 text-amber-100" : "border-slate-700 bg-slate-900 text-slate-300";
  return (
    <div role="note" className={`rounded-lg border p-4 text-sm ${cls}`}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}

export function DraftBanner() {
  return (
    <Callout tone="warn" title="DRAFT: pending professional legal review">
      <p>
        This page is a plain-English draft. It has not yet been reviewed by a lawyer and may change before launch. FounderOS is not a law firm and this page is not legal advice.
        Last updated: <time dateTime={SITE.legalLastUpdated}>{SITE.legalLastUpdatedLabel}</time>.
      </p>
    </Callout>
  );
}

export function NotAdvice() {
  return <p className="text-xs text-slate-500">{NOT_ADVICE_SHORT}</p>;
}

/** Closing call to action. Access is by invitation, so the action is "Sign in" and the note says so. */
export function SignInCta({ heading = "Already have access?", children }: { heading?: string; children?: ReactNode }) {
  return (
    <aside aria-label="Sign in" className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <p className="text-lg font-semibold text-slate-100">{heading}</p>
      <div className="mt-2 text-sm text-slate-300">
        {children ?? <p>FounderOS accounts are created by an administrator, so access is by invitation for now. There is no self-serve signup yet.</p>}
      </div>
      <Link href="/login" className="mt-4 inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white">
        Sign in
      </Link>
    </aside>
  );
}

export function CardGrid({ items }: { items: { title: string; body: string; href?: string }[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {items.map((i) => (
        <li key={i.title} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="font-semibold text-slate-100">
            {i.href ? <Link href={i.href} className="hover:underline">{i.title}</Link> : i.title}
          </h3>
          <p className="mt-1 text-sm text-slate-300">{i.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** Prose helper for the draft legal pages. */
export function Legal({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-100">{heading}</h2>
      <div className="mt-2 space-y-3 text-slate-300">{children}</div>
    </section>
  );
}
