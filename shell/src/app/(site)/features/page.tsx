import Link from "next/link";
import { NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/features");

const FEATURES: { name: string; body: string }[] = [
  { name: "LegalAI", body: "Review a contract and see flagged clauses and missing provisions, draft documents, and research questions with citations back to the source text. Runs on private hardware. It supports your review and is not legal advice." },
  { name: "Compliance Center", body: "An obligations list matched to your business profile (entity type, state, employees) with due dates, status and reminders. You confirm what applies; it does not file anything for you." },
  { name: "Business Health", body: "Checks across Legal, Compliance, Finance, Operations, Sales and Security that read what the other tools know. Shows complete, needs attention or missing, never a score." },
  { name: "Document Vault", body: "A home for contracts and business documents, searchable and linkable to tasks, contacts and other records." },
  { name: "Tasks", body: "To-dos and reminders that can be linked to the records they come from." },
  { name: "CRM", body: "Contacts, companies and deals, with links to documents and tasks." },
  { name: "SOPs and business documents", body: "Write down repeatable processes and generate standard business documents from your profile as starting points to review." },
  { name: "Marketing", body: "Drafting help for marketing copy that starts from what the app knows about your business." },
  { name: "Finance tools", body: "Runway, break-even, pricing, contractor versus employee cost and tax reserve calculators. Save a calculation and Business Health can see it." },
  { name: "Ask FounderOS", body: "A read-only assistant that answers questions using your business profile and records. It cannot change your data." },
  { name: "Product Scan", body: "Point it at a git repository to get a summary of what a product contains, for people who build software." },
  { name: "Competitor Research", body: "Track competitors and collect research notes in one place." },
];

export default function Features() {
  return (
    <PageShell title="Features" lead="One business profile, many tools, all aware of each other.">
      <Section title="Tools">
        <ul className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f.name} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <h3 className="font-semibold text-slate-100">{f.name}</h3>
              <p className="mt-1 text-sm text-slate-300">{f.body}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Shared context">
        <p>Tools never reach into each other&apos;s data. Instead each one publishes a short summary and a few facts, and every tool can read the combined picture. You can also link any record to any other, such as a contract to a task and a contact.</p>
      </Section>
      <Section title="Honest limits">
        <p>Some tools are newer than others and features will change. AI answers can be wrong and should be checked. Everything here is general information, not legal, tax or financial advice. See <Link href="/ai-disclosure" className="underline">AI disclosure</Link>.</p>
      </Section>
      <SignInCta />
      <NotAdvice />
    </PageShell>
  );
}
