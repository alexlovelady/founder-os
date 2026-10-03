import { RunwayCalculator } from "@/components/site/Calculators";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/runway-calculator");

export default function Page() {
  return (
    <PageShell title="Runway calculator" lead="How many months of cash do you have? It runs in your browser and nothing you enter is sent anywhere.">
      <RunwayCalculator />
    </PageShell>
  );
}
