import { PricingCalculator } from "@/components/site/Calculators";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/pricing-calculator");

export default function Page() {
  return (
    <PageShell title="Pricing calculator" lead="Turn your costs and a target margin into a price. It runs in your browser and nothing you enter is sent anywhere.">
      <PricingCalculator />
    </PageShell>
  );
}
