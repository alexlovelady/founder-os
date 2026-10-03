import Link from "next/link";
import { CardGrid, NotAdvice, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/");

export default function Home() {
  return (
    <main id="main" className="mx-auto w-full max-w-5xl px-4 py-12 sm:py-20">
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-50 sm:text-5xl">Your back office for starting and running a business</h1>
      <p className="mt-5 max-w-2xl text-lg text-slate-300">
        Contracts, documents, compliance, tasks, customers and money in one place, with tools that share what they know about your business instead of starting from a blank page every time.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/login" className="rounded-lg bg-slate-100 px-5 py-2.5 font-medium text-slate-900 hover:bg-white">Sign in</Link>
        <Link href="/tools" className="rounded-lg border border-slate-600 px-5 py-2.5 font-medium text-slate-100 hover:bg-slate-900">Try the free tools</Link>
      </div>
      <p className="mt-3 text-sm text-slate-400">Access is by invitation for now: accounts are created by an administrator. See <Link href="/contact" className="underline">Contact</Link>.</p>

      <div className="mt-16 space-y-14">
        <Section title="What it does">
          <CardGrid
            items={[
              { title: "LegalAI", body: "AI-assisted contract review, drafting and research with citations, to support your own review.", href: "/legal-ai" },
              { title: "Compliance Center", body: "A list of obligations for your kind of business, with due dates and reminders you manage.", href: "/features" },
              { title: "Business Health", body: "What looks covered, what needs attention and what is missing. No invented score.", href: "/business-health" },
              { title: "Document Vault", body: "Keep contracts and business documents together, linked to the work they belong to.", href: "/features" },
              { title: "Tasks, CRM and SOPs", body: "Track to-dos, customers and leads, and write down how your business runs.", href: "/features" },
              { title: "Finance tools", body: "Runway, break-even, pricing, contractor cost and tax reserve calculators you can save and revisit.", href: "/tools" },
            ]}
          />
        </Section>

        <Section title="How the tools share context">
          <p>
            You describe your business once: what it does, how it is structured, where it operates and whether it has employees. Every tool starts from that profile. Each tool also publishes a short summary of what it knows, so the others can use it.
          </p>
          <p>
            For example, Business Health can notice that you have no recorded runway calculation, and the assistant, Ask FounderOS, can answer questions across your tasks, documents and contacts. It reads your data to answer; it does not change anything.
          </p>
        </Section>

        <Section title="Who it is for">
          <p>
            Solo founders and small teams who run the business side themselves: forming the company, signing contracts, hiring, keeping on top of filings and watching cash. It is built to organize and explain, so you know what to ask your lawyer or accountant, not to replace them.
          </p>
        </Section>

        <Section title="What it is not">
          <p>FounderOS is software. It is not a law firm, an accounting firm or a financial adviser, and its output is general information. AI can be wrong, so check anything important. See the <Link href="/ai-disclosure" className="underline">AI disclosure</Link> and <Link href="/security" className="underline">Security</Link> pages for specifics, including what is not done yet.</p>
        </Section>

        <SignInCta />
        <NotAdvice />
      </div>
    </main>
  );
}
