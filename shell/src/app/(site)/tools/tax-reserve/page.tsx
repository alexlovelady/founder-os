import { TaxReserveCalculator } from "@/components/site/Calculators";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/tax-reserve");

export default function Page() {
  return (
    <PageShell title="Tax reserve calculator" lead="Estimate how much income to set aside, using a percentage you choose. It runs in your browser and nothing you enter is sent anywhere.">
      <TaxReserveCalculator />
    </PageShell>
  );
}
