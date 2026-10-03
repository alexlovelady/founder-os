import Link from "next/link";
import { DraftBanner, Legal, PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { NOT_A_FIRM } from "@/lib/site/config";

export const metadata = pageMetadata("/ai-disclosure");

export default function AiDisclosure() {
  return (
    <PageShell title="AI disclosure (draft)" lead="How AI is used in FounderOS, in plain English." narrow>
      <DraftBanner />
      <Legal heading="Where AI is used">
        <p>AI powers LegalAI (contract review, drafting and cited research), the Ask FounderOS assistant and drafting help in some other tools. Calculators and checklists are ordinary software and do not use AI.</p>
      </Legal>
      <Legal heading="Where it runs">
        <p>AI runs on private hardware operated by FounderOS for now. Your text is not sent to a third-party AI company. If that changes, for example with future paid plans that use other providers, we will update this page first and say which features are affected.</p>
      </Legal>
      <Legal heading="What we do not do">
        <ul className="list-disc space-y-1 pl-5">
          <li>We do not use your data to train AI models.</li>
          <li>The Ask FounderOS assistant is read-only: it answers questions and cannot change your records.</li>
        </ul>
      </Legal>
      <Legal heading="What AI can get wrong">
        <p>AI can misread a document, miss something important, make up details or sound sure when it is wrong. Citations help you check, but you must still check. Do not rely on AI output as the only basis for a legal, tax or financial decision.</p>
      </Legal>
      <Legal heading="Not professional advice">
        <p>{NOT_A_FIRM} Using LegalAI does not create an attorney-client relationship.</p>
      </Legal>
      <Legal heading="Availability">
        <p>Because AI runs on private hardware, it can be slow or unavailable at times. Where possible the tools offer a way to continue without it.</p>
      </Legal>
      <Legal heading="More">
        <p>See the <Link href="/privacy" className="underline">privacy draft</Link> and the <Link href="/security" className="underline">security page</Link>.</p>
      </Legal>
    </PageShell>
  );
}
