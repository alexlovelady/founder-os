import Link from "next/link";
import { Callout, NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/legal-ai");

export default function LegalAi() {
  return (
    <PageShell title="LegalAI: contract review, drafting and cited research" lead="A software tool that helps you read, draft and research legal documents faster, and see where the answer came from.">
      <Callout tone="warn" title="Not a law firm">
        <p>LegalAI is software. It does not provide legal advice, does not create an attorney-client relationship and is not a substitute for a lawyer. Have a qualified lawyer review anything that matters.</p>
      </Callout>
      <Section title="What it does">
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>Contract review.</strong> Upload a contract and see clauses worth a closer look and provisions that appear to be missing.</li>
          <li><strong>Drafting.</strong> Produce a first draft of a document and revisions you can edit and compare.</li>
          <li><strong>Cited research.</strong> Ask a question and get an answer that points back to the source text, so you can read the source yourself.</li>
        </ul>
      </Section>
      <Section title="How to use it well">
        <p>Treat the output as a prompt for your own review. AI can miss things, misread a clause or be confidently wrong. Citations help you check, but you still need to check. See the <Link href="/ai-disclosure" className="underline">AI disclosure</Link>.</p>
      </Section>
      <Section title="Where your documents go">
        <p>AI runs on private hardware operated by FounderOS for now, not on a third-party AI service, and customer data is not used to train models. Details are in the <Link href="/privacy" className="underline">privacy draft</Link> and on the <Link href="/security" className="underline">security page</Link>.</p>
      </Section>
      <Section title="Not built yet">
        <p>A free public contract checker and NDA generator are not available. They need the AI backend and are not part of the free tools.</p>
      </Section>
      <SignInCta />
      <NotAdvice />
    </PageShell>
  );
}
