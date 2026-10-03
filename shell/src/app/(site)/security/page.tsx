import Link from "next/link";
import { Callout, NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { SITE } from "@/lib/site/config";

export const metadata = pageMetadata("/security");

export default function Security() {
  return (
    <PageShell title="Security" lead="What FounderOS does to protect your data today, and what it does not do yet.">
      <Callout title="No third-party certifications">
        <p>FounderOS has not been through an independent security audit and holds no third-party security attestation. We describe what the software does, and we will not claim more than that.</p>
      </Callout>

      <Section title="What is in place">
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>Authentication.</strong> Passwords are stored as salted hashes (Argon2), never in readable form. Optional two-step sign-in with an authenticator app is supported, with one-time recovery codes. Two-step secrets are stored encrypted. Accounts are created by an administrator.</li>
          <li><strong>Access controls.</strong> Who you are is checked on the server for every protected page and request, not only hidden in the browser. People on a team have roles, and read-only users cannot change data.</li>
          <li><strong>Data isolation.</strong> Every business&apos;s records are tied to that business, and every query is filtered by it. Tests check that one business cannot read or change another&apos;s data.</li>
          <li><strong>Audit trail.</strong> LegalAI records an append-only log of important actions. We do not put document text or secrets in it.</li>
          <li><strong>Browser protections.</strong> The LegalAI service sends security headers, including a content security policy, HTTP strict transport security and limits on being embedded in other sites. Traffic to the site is over HTTPS.</li>
          <li><strong>Private AI.</strong> AI runs on private hardware operated by FounderOS for now, so your documents are not sent to a third-party AI provider. See the <Link href="/ai-disclosure" className="underline">AI disclosure</Link>.</li>
        </ul>
      </Section>

      <Section title="What is not done yet">
        <ul className="list-disc space-y-2 pl-5">
          <li>No independent security audit or penetration test.</li>
          <li>No third-party certification of any kind.</li>
          <li>No additional application-level encryption of stored documents beyond what the hosting provider offers.</li>
          <li>No published, tested disaster-recovery procedure, and no formal incident-response program.</li>
          <li>Single sign-on is not available.</li>
          <li>Because AI runs on one private machine for now, AI features can be slow or unavailable.</li>
        </ul>
      </Section>

      <Section title="What you can do">
        <p>Turn on two-step sign-in, use a unique password, give teammates the lowest role that works, and avoid uploading information you do not need to store.</p>
      </Section>

      <Section title="Reporting a security issue">
        {SITE.contactEmail ? (
          <p>Email <a href={`mailto:${SITE.contactEmail}`} className="underline">{SITE.contactEmail}</a> with the details. Please do not include other people&apos;s data in your report.</p>
        ) : (
          <p>A security reporting address is not published yet. It will appear here. In the meantime, if you have access, tell the administrator who invited you.</p>
        )}
      </Section>
      <SignInCta />
      <NotAdvice />
    </PageShell>
  );
}
