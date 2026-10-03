import Link from "next/link";
import { NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/business-health");

export default function BusinessHealth() {
  return (
    <PageShell title="Business Health" lead="Know what your business needs before it becomes a problem.">
      <Section title="Category by category, with no score">
        <p>Business Health looks at Legal, Compliance, Finance, Operations, Sales and Security. Each area shows as complete, needs attention or missing, with the specific items behind it and where to fix them.</p>
        <p>There is deliberately no numeric score. A single number would suggest a precision and quality judgment that a checklist cannot give.</p>
      </Section>
      <Section title="It reads what the other tools know">
        <p>Inside the app, Business Health checks facts the other tools publish, such as whether you have saved a runway calculation or have overdue compliance items. Things it cannot know are shown as not tracked yet, never as complete.</p>
      </Section>
      <Section title="Try a short version now">
        <p>The free <Link href="/tools/business-health-check" className="underline">business health check</Link> runs entirely in your browser from a few questions and sends nothing anywhere.</p>
      </Section>
      <SignInCta />
      <NotAdvice />
    </PageShell>
  );
}
