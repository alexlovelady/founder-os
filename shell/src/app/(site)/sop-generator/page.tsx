import Link from "next/link";
import { NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { Faq, type FaqItem } from "../contract-review/_faq";

export const metadata = pageMetadata("/sop-generator");

/** The ten sections the SOP builder always produces (SOP_SECTIONS in modules/sops/src/sop.ts), with what goes in each. */
const SECTIONS: { name: string; body: string }[] = [
  { name: "Purpose", body: "Why the procedure exists and what a good result looks like." },
  { name: "Owner", body: "Who is responsible for doing it, or for keeping it up to date." },
  { name: "Frequency", body: "How often it happens: every day, on each new customer, at month end." },
  { name: "Required Tools", body: "The software, accounts and equipment needed." },
  { name: "Prerequisites", body: "What must be true or ready before the first step, including inputs to have on hand." },
  { name: "Procedure", body: "The steps, numbered, one action each, in order." },
  { name: "Quality Checks", body: "A tick-box list for confirming it was done properly." },
  { name: "Exceptions", body: "What to do when something does not go to plan." },
  { name: "Escalation", body: "Who to tell, and when, if you cannot resolve it." },
  { name: "Revision History", body: "A dated record of changes, starting with the first version." },
];

const FAQ: FaqItem[] = [
  {
    q: "Do I need AI to build an SOP?",
    a: "No. The SOP builder is a form plus a formatter that always gives the same document for the same answers. AI drafting, improving and expanding are optional extras in the signed-in app; their output is labelled a draft, counts against your plan's AI request limit, and can be wrong, so check it.",
  },
  {
    q: "What happens to a question I leave blank?",
    a: "The section shows the visible marker [●TO FILL IN] instead of an invented answer, so you can see what is still missing.",
  },
  {
    q: "Can I use my own wording?",
    a: "Yes. The result opens in an editor with a live preview. Every save keeps a version you can restore, and you can set a review cycle (none, quarterly or yearly) and mark the document as reviewed.",
  },
  {
    q: "How do I get it out of FounderOS?",
    a: "Download Markdown, download a Word-compatible file (an HTML-based document that Word opens, not a native Word file), or print or save as PDF from your browser.",
  },
  {
    q: "Can it turn the steps into tasks?",
    a: "Yes. In the app, Create tasks from these steps adds each step to your task list, and Turn into a checklist rewrites the steps as tick-box items.",
  },
  {
    q: "Is there a public SOP form on this page?",
    a: "No. This page describes the builder, which lives in the signed-in app, so your procedures are saved with your business. Access is by invitation for now.",
  },
];

export default function SopGenerator() {
  return (
    <PageShell
      title="SOP generator: write a standard operating procedure"
      lead="Turn what is in your head into a written procedure anyone on your team can follow. The SOP builder in FounderOS works without AI and produces the same ten sections every time."
    >
      <Section title="What an SOP is">
        <p>A standard operating procedure (SOP) is a short written description of how a recurring job is done: who does it, with what, in which steps, and how you know it was done properly. Writing it down means the work does not depend on one person remembering, and a new hire, a contractor or a backup person can pick it up.</p>
      </Section>

      <Section title="The ten sections">
        <p>Every SOP the builder produces has these sections, in this order:</p>
        <ol className="list-decimal space-y-2 pl-5">
          {SECTIONS.map((s) => (
            <li key={s.name}><strong>{s.name}.</strong> {s.body}</li>
          ))}
        </ol>
      </Section>

      <Section title="How the builder works">
        <p>You describe the procedure in a guided form: its name, the goal, who does it, the tools, the inputs, the steps (one per line), exceptions, the expected result, how often it happens, prerequisites, quality checks and who to escalate to. The formatter turns your answers into the ten sections, numbers the steps, turns quality checks into tick boxes and adds a first revision-history line. If you leave a part blank, it shows <code className="rounded bg-slate-800 px-1">[●TO FILL IN]</code> so nothing is silently invented.</p>
        <p>After that it is an ordinary document in the app: edit it, keep a version history and restore an earlier version, set a review cycle, download Markdown or a Word-compatible file, print or save as PDF, and turn the steps into a checklist or into tasks. The same area also keeps everyday business documents such as proposals, quotes, policies, job descriptions, onboarding checklists and meeting agendas, filled in from your business profile.</p>
      </Section>

      <Section title="Tips for a procedure people will follow">
        <ul className="list-disc space-y-2 pl-5">
          <li>One action per step, starting with a verb, in the order it happens.</li>
          <li>Name the tool and where to find things in each step rather than assuming people know.</li>
          <li>Write the exceptions you have actually met, not every imaginable one.</li>
          <li>Give it an owner and a review cycle, so it does not go stale unnoticed.</li>
          <li>Test it by asking someone who has never done the job to follow it and note where they get stuck.</li>
        </ul>
      </Section>

      <Section title="Where SOPs show up elsewhere in FounderOS">
        <p>Business Health looks at your SOP titles for a customer onboarding procedure, an incident plan and a backup plan, and tells you which look missing. The assistant can propose a draft SOP for you to review, but it never activates one on its own. See <Link href="/business-health" className="underline">Business Health</Link> and the <Link href="/tools/business-health-check" className="underline">free business health check</Link>.</p>
      </Section>

      <Section title="Related free tools">
        <ul className="list-disc space-y-2 pl-5">
          <li><Link href="/tools/startup-checklist" className="underline">Startup checklist</Link>: generic startup steps with links to official sources.</li>
          <li><Link href="/tools/business-health-check" className="underline">Business health check</Link>: which areas look covered and which are missing.</li>
          <li><Link href="/contractor-agreement" className="underline">Contractor agreement guide</Link> and <Link href="/nda-generator" className="underline">NDA guide</Link>.</li>
          <li><Link href="/features" className="underline">All features</Link>.</li>
        </ul>
      </Section>

      <Faq items={FAQ} />
      <SignInCta heading="Build an SOP in the app">
        <p>The SOP builder runs in the signed-in app so your procedures are saved with your business. FounderOS accounts are created by an administrator, so access is by invitation for now.</p>
      </SignInCta>
      <NotAdvice />
    </PageShell>
  );
}
