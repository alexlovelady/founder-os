import Link from "next/link";
import { Callout, NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { Faq, type FaqItem } from "../contract-review/_faq";

export const metadata = pageMetadata("/nda-generator");

/** Conventional clause order used by the in-app drafting outline for a mutual NDA (modules/legal startup catalog). */
const OUTLINE: { name: string; body: string }[] = [
  { name: "Purpose", body: "Why the information is being shared, for example exploring a possible partnership. A narrow purpose keeps the agreement from sweeping in more than you intend." },
  { name: "What counts as confidential information", body: "The kinds of information covered, and how it is identified (marked, or obvious from the circumstances)." },
  { name: "Obligations of the receiving party", body: "Keep it private, use it only for the purpose, and share it only with people who need it and are bound to keep it private." },
  { name: "Exclusions", body: "The usual carve-outs: information that is already public, already known to the receiver, independently developed, or received from someone else without a duty of confidence." },
  { name: "Required disclosures", body: "What happens if a court or authority orders disclosure." },
  { name: "Term and survival", body: "How long the agreement lasts and how long secrets stay protected after it ends." },
  { name: "Return or destruction of materials", body: "What the receiver does with documents and copies when asked." },
  { name: "No license or other rights", body: "Sharing information does not hand over ownership or any right to use it beyond the purpose." },
  { name: "Remedies", body: "What the disclosing party can do if the agreement is broken." },
  { name: "Governing law", body: "Which state's law applies." },
  { name: "General provisions", body: "Notices, changes in writing, what happens if one clause fails, and the like." },
];

const CHECKLIST = [
  "Who the parties are: the full legal names of both companies or people.",
  "Whether both sides will share secrets (mutual) or only one (one-way).",
  "The purpose, in a sentence.",
  "What kinds of information you are worried about, so the definition covers them.",
  "How long the agreement should last, and how long information should stay protected afterwards.",
  "Who on each side will see the information, including advisers and contractors.",
  "The state whose law should govern.",
  "Whether an NDA is the right tool. If the real concern is that someone might compete or hire your people, an NDA is not the place for that, and the rules for such terms vary by state.",
];

const FAQ: FaqItem[] = [
  {
    q: "Is there a free NDA generator on this page?",
    a: "No. This page is a guide to what a mutual NDA usually covers. It is not a form, and nothing you type here is sent anywhere. The signed-in app drafts a mutual NDA; the page name reflects what people search for.",
  },
  {
    q: "What does the in-app NDA draft ask for?",
    a: "Your company, the other party, the purpose of sharing information, how long the agreement lasts (the default offered is two years), how long information stays protected after it ends (the default offered is three years) and the governing state. You can change the defaults. Anything left blank becomes a visible placeholder rather than an invented value.",
  },
  {
    q: "Does it draft one-way NDAs?",
    a: "Not as a built-in template. The built-in NDA is mutual and balanced. If you need a one-way agreement, ask a lawyer, or upload one you have been given and run a contract review on it.",
  },
  {
    q: "Does the draft include a non-compete or non-solicit?",
    a: "No. The NDA outline is confidentiality only. Non-compete and non-solicitation terms are a different subject, with rules that vary by state, and are better handled by a lawyer.",
  },
  {
    q: "Can I rely on the draft as it is?",
    a: "No. FounderOS is software, not a law firm. The outline is a conventional order, not advice for your situation. Have a lawyer review any NDA that matters before it is signed.",
  },
  {
    q: "I was sent an NDA to sign. Can FounderOS read it?",
    a: "In the signed-in app you can upload it for a contract review: a plain-English summary, issues with quotes checked against the text, and a Word file with tracked changes. It does not tell you whether to sign.",
  },
];

export default function NdaGenerator() {
  return (
    <PageShell
      title="NDA generator: what a mutual NDA covers"
      lead="A plain-English guide to the agreement you use before sharing sensitive information with a partner, vendor or investor, and what to decide before you draft one."
    >
      <Callout tone="warn" title="General information, not legal advice">
        <p>This page explains a type of document in general terms. FounderOS is software, not a law firm. Drafting happens in the signed-in app, there is no generator form on this page, and any NDA should be reviewed by a qualified lawyer before it is signed.</p>
      </Callout>

      <Section title="What it is">
        <p>A non-disclosure agreement (NDA), also called a confidentiality agreement, is a contract in which one or both sides agree to keep certain information private and to use it only for a stated purpose. A <em>mutual</em> NDA binds both sides, which is the usual starting point when two companies are talking to each other and each will share something.</p>
      </Section>

      <Section title="What a mutual NDA typically includes">
        <p>The in-app drafting outline follows this conventional order:</p>
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
      </Section>

      <Section title="Drafting it in FounderOS">
        <p>In the signed-in app, Create a document asks a few plain questions, drafts a mutual NDA from the outline above, marks every fact you did not give with a visible placeholder, and lets you download a Word file. The legal checklist ticks itself when it recognizes an uploaded NDA. If someone else sent you an NDA, a <Link href="/contract-review" className="underline">contract review</Link> reads it and flags what to look at.</p>
      </Section>

      <Section title="Related free tools">
        <ul className="list-disc space-y-2 pl-5">
          <li><Link href="/tools/startup-checklist" className="underline">Startup checklist</Link>: generic steps with links to official sources.</li>
          <li><Link href="/contractor-agreement" className="underline">Contractor agreement guide</Link>: another document founders often need early.</li>
          <li><Link href="/tools/business-health-check" className="underline">Business health check</Link>: see which areas look covered and which are missing.</li>
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
