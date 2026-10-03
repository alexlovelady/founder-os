import Link from "next/link";
import { DraftBanner, Legal, PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { NOT_A_FIRM } from "@/lib/site/config";

export const metadata = pageMetadata("/terms");

export default function Terms() {
  return (
    <PageShell title="Terms of Service (draft)" lead="Plain-English terms for using FounderOS." narrow>
      <DraftBanner />
      <Legal heading="1. What FounderOS is">
        <p>FounderOS is a set of software tools for starting and running a business. {NOT_A_FIRM}</p>
      </Legal>
      <Legal heading="2. Accounts">
        <p>Accounts are created by an administrator. You are responsible for keeping your sign-in details private and for what happens under your account. Tell us if you think someone else has access.</p>
      </Legal>
      <Legal heading="3. Your content">
        <p>You keep ownership of the business information and documents you put into FounderOS. You give us permission to store and process them only to run the service for you, including running the AI features you ask for. You are responsible for having the right to upload what you upload.</p>
      </Legal>
      <Legal heading="4. Information, not advice">
        <p>Outputs from the tools, including AI output, calculators, checklists and compliance lists, are general information. They may be incomplete, out of date or wrong. They are not legal, tax, accounting or financial advice. Please check important matters with a qualified professional before acting.</p>
      </Legal>
      <Legal heading="5. Acceptable use">
        <p>Do not use FounderOS to break the law, to attack or probe the service, to upload malicious files, or to use the service in a way that harms others or the availability of the service.</p>
      </Legal>
      <Legal heading="6. Plans and payment">
        <p>Plans and limits are described on the <Link href="/pricing" className="underline">pricing page</Link>. Checkout is not live yet. When billing is enabled, the billing terms that apply will be added here before you are charged.</p>
      </Legal>
      <Legal heading="7. Availability and changes">
        <p>The service is new and features change. AI features run on private hardware and may be slow or unavailable. We may change or remove features, and we will try to give notice of significant changes.</p>
      </Legal>
      <Legal heading="8. Ending your use">
        <p>You can stop using FounderOS at any time and ask for your data to be exported or deleted. We may suspend an account that breaks these terms.</p>
      </Legal>
      <Legal heading="9. Liability">
        <p>[Pending legal review: limits on liability, disclaimers of warranties, indemnity, governing law and dispute resolution will be written by a lawyer.]</p>
      </Legal>
      <Legal heading="10. Contact">
        <p>See the <Link href="/contact" className="underline">contact page</Link>.</p>
      </Legal>
    </PageShell>
  );
}
