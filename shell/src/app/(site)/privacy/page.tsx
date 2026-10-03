import Link from "next/link";
import { DraftBanner, Legal, PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { NOT_A_FIRM } from "@/lib/site/config";

export const metadata = pageMetadata("/privacy");

export default function Privacy() {
  return (
    <PageShell title="Privacy Policy (draft)" lead="What FounderOS collects, where it goes and how it is used." narrow>
      <DraftBanner />
      <Legal heading="Who we are">
        <p>FounderOS is software for running a business. {NOT_A_FIRM}</p>
      </Legal>
      <Legal heading="This public website">
        <p>The public pages and free tools do not ask you to sign in. The free calculators, startup checklist and health check run in your browser: what you type is not sent to us or anyone else and is not saved. We do not currently use advertising trackers on these pages.</p>
      </Legal>
      <Legal heading="What we collect when you have an account">
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Account details:</strong> your name, email address and a salted hash of your password (never the password itself), plus two-step sign-in data if you turn it on.</li>
          <li><strong>Business profile:</strong> what you enter about your business, such as its name, structure, state, stage and whether it has employees.</li>
          <li><strong>Your content:</strong> documents, contracts, tasks, contacts, calculations and notes you add to the tools.</li>
          <li><strong>Usage records:</strong> counts such as AI requests and storage used, to apply plan limits, and an audit log of important actions.</li>
          <li><strong>Sign-in cookie:</strong> an essential cookie that keeps you signed in. We do not use it for advertising.</li>
        </ul>
      </Legal>
      <Legal heading="How we use it">
        <p>To run the service for you: to show your data, run the tools and AI features you ask for, apply plan limits, keep the service secure and fix problems. We do not sell your data.</p>
      </Legal>
      <Legal heading="AI processing">
        <p>When you use an AI feature, the relevant text is sent to private hardware operated by FounderOS for processing. It is not sent to a third-party AI provider today. We do not use customer data to train AI models. See the <Link href="/ai-disclosure" className="underline">AI disclosure</Link>.</p>
      </Legal>
      <Legal heading="Who else handles data">
        <p>Our hosting provider stores and serves the application and database. When billing is enabled, a payment processor (Stripe) will handle payment details; we will not store card numbers ourselves. This list will be kept up to date here.</p>
      </Legal>
      <Legal heading="Keeping and deleting data">
        <p>We keep your data while your account is active. You can ask for an export or for deletion of your data. [Pending legal review and a documented retention schedule: how long backups and logs are kept after deletion.]</p>
      </Legal>
      <Legal heading="Your choices and rights">
        <p>[Pending legal review: rights that apply in your location (for example access, correction, deletion and objection) and how to exercise them.]</p>
      </Legal>
      <Legal heading="Security">
        <p>See the <Link href="/security" className="underline">security page</Link> for what is in place and what is not done yet.</p>
      </Legal>
      <Legal heading="Contact">
        <p>See the <Link href="/contact" className="underline">contact page</Link>.</p>
      </Legal>
    </PageShell>
  );
}
