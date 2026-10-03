import StartupChecklist from "@/components/site/StartupChecklist";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/startup-checklist");

export default function Page() {
  return (
    <PageShell title="Startup checklist" lead="Answer a few questions to get a list of generic startup steps with links to official government sources. It runs in your browser and nothing you enter is sent anywhere.">
      <StartupChecklist />
    </PageShell>
  );
}
