import HealthCheck from "@/components/site/HealthCheck";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/business-health-check");

export default function Page() {
  return (
    <PageShell title="Business health check" lead="A short questionnaire showing which areas look covered, which need attention and which are missing. There is no score. It runs in your browser and nothing you enter is sent anywhere.">
      <HealthCheck />
    </PageShell>
  );
}
