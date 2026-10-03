import Link from "next/link";
import { Callout, NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { Faq, type FaqItem } from "./_faq";

export const metadata = pageMetadata("/contract-review");

const FAQ: FaqItem[] = [
  {
    q: "Can I try a contract review without signing in?",
    a: "No. There is no public contract checker. The review runs inside the signed-in FounderOS app, because it needs the AI service and stores your contract and results in your workspace. Access is by invitation for now.",
  },
  {
    q: "Does the review replace a lawyer?",
    a: "No. LegalAI is software, not a law firm. It gives you a structured first read so you know what to look at and what to ask. For anything that matters, have a qualified lawyer review the contract.",
  },
  {
    q: "How do I know the quotes are real?",
    a: "A quote is shown only if it appears word for word in the clause it points to; otherwise it is removed and a warning is shown. In the plain-English summary, each key term is marked checked when its wording is found in the contract and verify when it is not. That check catches invented wording. It does not tell you whether a clause is fair or enforceable.",
  },
  {
    q: "Which files can I upload?",
    a: "PDF, Word (.docx), plain text, Markdown, HTML and email (.eml) files, and scanned pages or images, which are read with OCR. OCR is flagged wherever it is used, because quotes are then checked against recognized text, which can differ from the image where recognition went wrong.",
  },
  {
    q: "How long does a review take?",
    a: "A careful review of a long contract can take a few minutes. The AI runs on a private computer that FounderOS operates. If that computer is offline, your request waits and finishes when it is back; nothing is lost.",
  },
  {
    q: "Where does my contract go?",
    a: "AI runs on private hardware operated by FounderOS for now, not on a third-party AI service, and customer data is not used to train models. See the AI disclosure, the privacy draft and the security page for the details and for what is not done yet.",
  },
  {
    q: "What does it cost?",
    a: "Reviews count against your plan's AI request limit. See the pricing page for the current plans; checkout is not live yet.",
  },
];

const RATINGS = [
  { label: "Do not sign yet", when: "at least one critical issue was found" },
  { label: "Needs your attention", when: "at least one high-risk issue was found" },
  { label: "A few things to check", when: "medium-risk issues were found" },
  { label: "Looks routine", when: "nothing above low risk was found" },
];

export default function ContractReview() {
  return (
    <PageShell
      title="Contract review: a plain-English read with checked quotes"
      lead="Upload a contract, say which side you are on, and get an overall rating, a summary a non-lawyer can follow, the issues in order of importance, and a Word file with tracked changes."
    >
      <Callout tone="warn" title="Not a law firm">
        <p>LegalAI is software. It does not give legal advice, does not create an attorney-client relationship and is not a substitute for a lawyer. Treat the output as a prompt for your own review and have a qualified lawyer look at anything important.</p>
      </Callout>

      <Section title="What you get">
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>An overall rating.</strong> One of four plain labels, worked out from the issues found rather than from a made-up score: {RATINGS.map((r) => `"${r.label}" (${r.when})`).join("; ")}. The label flags how serious the issues found are; it is not advice on whether to sign.</li>
          <li><strong>A plain-English summary.</strong> What the contract says in short sentences, with key terms such as dates and amounts. Each key term is marked checked if its wording is found in the contract, or verify if it is not.</li>
          <li><strong>Issues, most important first.</strong> Each has a reason in plain language and, where there is one, a quote taken from the contract and checked word for word. Some come with suggested replacement wording.</li>
          <li><strong>What is missing.</strong> Topics that contracts like this usually cover and this one does not mention, found by software rather than by the AI.</li>
          <li><strong>Questions to ask the other side</strong> and a short list of things to watch out for.</li>
          <li><strong>A Word file with tracked changes.</strong> Open it in Word and accept or reject each change before you send it back. A change is skipped, and reported, if the original text no longer matches the contract.</li>
        </ul>
      </Section>

      <Section title="How it works">
        <p>The contract is split into clauses. Software looks for missing topics, capitalized terms that are used but never defined, defined terms that are never used and cross-references to something that is not in the document. An AI model then assesses the clauses and explains the issues, and code checks what it said: it can only point to clauses that exist, and a quote that is not in the clause is removed.</p>
        <p>You choose a perspective: neutral, customer, vendor, employer or employee, because the same clause can help one side and hurt the other. For founders agreements, LLC operating agreements, SAFE and convertible notes, and contractor or IP assignment agreements, LegalAI recognizes the document type and applies a matching checklist of provisions to look for. Other contracts use a balanced commercial checklist, and you can write your own.</p>
        <p>The review runs on a private GPU operated by FounderOS. Learn more on the <Link href="/legal-ai" className="underline">LegalAI page</Link>, the <Link href="/ai-disclosure" className="underline">AI disclosure</Link> and the <Link href="/security" className="underline">security page</Link>.</p>
      </Section>

      <Section title="What it will not do">
        <ul className="list-disc space-y-2 pl-5">
          <li>Tell you whether to sign.</li>
          <li>Say that a clause is enforceable, fair or legal in your state.</li>
          <li>Know law that is not in its library. The library is public text from official sources with honest gaps; it does not say a case is still good law.</li>
          <li>Catch everything. AI can miss a problem or misread a clause. The quote check reduces invented wording; it does not make the substance right.</li>
        </ul>
      </Section>

      <Section title="Before you sign: related free tools">
        <ul className="list-disc space-y-2 pl-5">
          <li><Link href="/tools/startup-checklist" className="underline">Startup checklist</Link>: generic startup steps with links to official government sources.</li>
          <li><Link href="/tools/contractor-vs-employee" className="underline">Contractor vs employee cost calculator</Link>: cost only, not a classification.</li>
          <li><Link href="/contractor-agreement" className="underline">Contractor agreement guide</Link> and <Link href="/nda-generator" className="underline">NDA guide</Link>: what those documents usually cover.</li>
          <li><Link href="/tools/business-health-check" className="underline">Business health check</Link>: see which areas look covered and which are missing.</li>
        </ul>
      </Section>

      <Faq items={FAQ} />
      <SignInCta heading="Review a contract in the app">
        <p>Contract review runs in the signed-in app, so you need an account. FounderOS accounts are created by an administrator, so access is by invitation for now.</p>
      </SignInCta>
      <NotAdvice />
    </PageShell>
  );
}
