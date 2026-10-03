import { NotAdvice, PageShell, Section, SignInCta } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";
import { SITE } from "@/lib/site/config";

export const metadata = pageMetadata("/contact");

export default function Contact() {
  return (
    <PageShell title="Contact" lead="FounderOS is invitation-only for now.">
      <Section title="Getting access">
        <p>There is no self-serve signup yet. Accounts are created by an administrator. If you have been invited, use Sign in below. If you would like to be considered for access, contact us.</p>
      </Section>
      {SITE.contactEmail ? (
        <Section title="Email">
          <p><a href={`mailto:${SITE.contactEmail}`} className="underline">{SITE.contactEmail}</a></p>
        </Section>
      ) : (
        <Section title="Email">
          <p>A public contact address has not been published yet.</p>
        </Section>
      )}
      <p className="text-sm text-slate-400">Please do not send confidential or legal documents by email. We cannot give legal, tax or financial advice.</p>
      <SignInCta />
      <NotAdvice />
    </PageShell>
  );
}
