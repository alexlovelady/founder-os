import Link from "next/link";
import { NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { PAGES, pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools");

export default function Tools() {
  const tools = PAGES.filter((p) => p.path.startsWith("/tools/"));
  return (
    <PageShell title="Free business tools" lead="Useful on their own, with no account. Everything runs in your browser and nothing you type is sent anywhere.">
      <Section title="Tools">
        <ul className="grid gap-4 sm:grid-cols-2">
          {tools.map((t) => (
            <li key={t.path} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <h3 className="font-semibold text-slate-100"><Link href={t.path} className="hover:underline">{t.title}</Link></h3>
              <p className="mt-1 text-sm text-slate-300">{t.description}</p>
            </li>
          ))}
        </ul>
      </Section>
      <SignInCta heading="Want to save your results?">
        <p>Inside FounderOS you can save calculations and track them over time. Access is by invitation for now.</p>
      </SignInCta>
      <NotAdvice />
    </PageShell>
  );
}
