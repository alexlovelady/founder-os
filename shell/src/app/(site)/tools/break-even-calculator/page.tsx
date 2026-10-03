import { BreakEvenCalculator } from "@/components/site/Calculators";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/break-even-calculator");

export default function Page() {
  return (
    <PageShell title="Break-even calculator" lead="How many sales cover your fixed costs? It runs in your browser and nothing you enter is sent anywhere.">
      <BreakEvenCalculator />
    </PageShell>
  );
}
