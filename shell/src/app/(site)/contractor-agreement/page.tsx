import Link from "next/link";
import { Callout, NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { ALL_CHECKLIST_LINKS } from "@/lib/site/checklist";
import { pageMetadata } from "@/lib/site/pages";
import { Faq, type FaqItem } from "../contract-review/_faq";

export const metadata = pageMetadata("/contractor-agreement");

const IRS_CONTRACTOR = ALL_CHECKLIST_LINKS.find((l) => l.href.endsWith("independent-contractor-self-employed-or-employee"));

/** Conventional clause order used by the in-app drafting outline for an independent contractor agreement (modules/legal startup catalog). */
const OUTLINE: { name: string; body: string }[] = [
  { name: "Services and deliverables", body: "What the contractor will do, written specifically enough that both sides can tell when it is done." },
  { name: "Fees, invoices and expenses", body: "How much, when invoices are sent, when they are due and whether expenses are reimbursed." },
  { name: "Term and termination", body: "When the work starts, how long it lasts and how either side can end it." },
  { name: "Independent contractor relationship", body: "States that the contractor is not an employee and controls how the work is done." },
  { name: "Ownership of work product", body: "Who owns what the contractor makes. Founders often look for wording that assigns ownership now, rather than a promise to assign later; ask a lawyer which wording fits your state." },
  { name: "Contractor's pre-existing materials and license", body: "Tools and material the contractor already owned, and the license the company gets to use any that end up in the work." },
  { name: "Confidentiality", body: "What the contractor must keep private and for how long." },
  { name: "Warranties", body: "Typically that the work is original, does not infringe someone else's rights and follows your rule on open-source code." },
  { name: "Indemnity and limits", body: "Who covers what if something goes wrong, and any cap on liability." },
  { name: "Governing law", body: "Which state's law applies." },
  { name: "General provisions", body: "The boilerplate: notices, changes in writing, what happens if one clause fails." },
];

const CHECKLIST = [
  "Your company's legal name and the contractor's full legal name (or business name).",
  "A specific description of the services and what counts as finished.",
  "The fee, how it is calculated (hourly, fixed, milestones), when invoices go out and the payment deadline.",
  "The start date and how long the engagement lasts, and how either side can end it.",
  "Who will own the work product, and what the contractor keeps from before the engagement.",
  "Whether the contractor will see confidential information, and for how long it must stay private.",
  "The state whose law should govern.",
  "Whether the relationship really looks like a contractor relationship (see the FAQ).",
];

const FAQ: FaqItem[] = [
  {
    q: "Does signing a contractor agreement make someone a contractor?",
    a: "No. Whether a person is a contractor or an employee depends on how the relationship actually works and on the tests in federal and state law, not on the label in the agreement. The agreement should describe the relationship accurately, and you should check the tests that apply to you with a professional.",
  },
  {
    q: "Can FounderOS generate a contractor agreement for me?",
    a: "Inside the signed-in app, the Create a document feature asks a few plain questions and drafts an independent contractor agreement from library templates and a standard clause outline. Anything you do not supply becomes a visible blank rather than an invented value. There is no public form on this page.",
  },
  {
    q: "Can I sign the draft as it is?",
    a: "No. A draft is a starting point. FounderOS is software, not a law firm, and the clause outline is a conventional order, not advice for your situation. Have a lawyer review it before anyone signs.",
  },
  {
    q: "I already have a contractor agreement. Can I check it?",
    a: "Yes, in the app. Contract review recognizes contractor and IP assignment agreements and applies a matching checklist, including whether ownership of the work is assigned and whether there is a warranty that the work is original. It flags what it finds with checked quotes; it does not tell you the agreement is enforceable.",
  },
  {
    q: "Is a contractor cheaper than an employee?",
    a: "The free contractor versus employee calculator compares yearly cost only. It does not decide how someone must be classified.",
  },
];

export default function ContractorAgreement() {
  return (
    <PageShell
      title="Contractor agreement: what an independent contractor agreement covers"
      lead="A plain-English guide to the document you use when a freelancer or consultant does work for your company: what it usually contains and what to decide before you draft it."
    >
      <Callout tone="warn" title="General information, not legal advice">
        <p>This page explains a type of document in general terms. FounderOS is software, not a law firm. Drafting happens in the signed-in app, there is no generator form on this page, and any agreement should be reviewed by a qualified lawyer before it is signed.</p>
      </Callout>

      <Section title="What it is">
        <p>An independent contractor agreement records the deal between your company and someone who is not an employee: what they will do, how and when they are paid, who owns what they create, what they must keep confidential and how the arrangement ends. For a startup, the ownership clause is often the one that matters most, because without a clear written transfer the person who wrote the code or made the logo may own it, not the company.</p>
      </Section>

      <Section title="What it typically includes">
        <p>The in-app drafting outline for this document follows this conventional order:</p>
        <ol className="list-decimal space-y-2 pl-5">
          {OUTLINE.map((o) => (
            <li key={o.name}><strong>{o.name}.</strong> {o.body}</li>
          ))}
        </ol>
      </Section>

      <Section title="What to decide before you draft">
        <ul className="list-disc space-y-2 pl-5">
          {CHECKLIST.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p>
          Contractor classification has real consequences for taxes and employment law, and the tests differ by state.
          {IRS_CONTRACTOR ? <> The IRS explains its approach on <a href={IRS_CONTRACTOR.href} className="underline" rel="noopener noreferrer">{IRS_CONTRACTOR.label}</a>.</> : null}
        </p>
      </Section>

      <Section title="Drafting it in FounderOS">
        <p>In the signed-in app, Create a document asks plain questions (your company, the contractor, the services, the fee, the term, who owns the work and the governing state), drafts from library templates and the outline above, leaves a visible placeholder for every fact you did not give, and lets you download a Word file. The legal checklist ticks itself when it recognizes an uploaded contractor agreement. You can also upload an agreement someone else sent you for a <Link href="/contract-review" className="underline">contract review</Link>.</p>
      </Section>

      <Section title="Related free tools">
        <ul className="list-disc space-y-2 pl-5">
          <li><Link href="/tools/contractor-vs-employee" className="underline">Contractor vs employee cost calculator</Link>: yearly cost comparison, runs in your browser.</li>
          <li><Link href="/tools/startup-checklist" className="underline">Startup checklist</Link>: generic steps with links to official sources.</li>
          <li><Link href="/nda-generator" className="underline">NDA guide</Link> and <Link href="/sop-generator" className="underline">SOP generator</Link>.</li>
          <li><Link href="/legal-ai" className="underline">LegalAI</Link>: review, drafting and cited research.</li>
        </ul>
      </Section>

      <Faq items={FAQ} />
      <SignInCta heading="Draft or review one in the app">
        <p>Drafting and review run in the signed-in app, so you need an account. FounderOS accounts are created by an administrator, so access is by invitation for now.</p>
      </SignInCta>
      <NotAdvice />
    </PageShell>
  );
}
