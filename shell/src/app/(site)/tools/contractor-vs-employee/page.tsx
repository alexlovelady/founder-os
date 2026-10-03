import { ContractorVsEmployee } from "@/components/site/Calculators";
import { PageShell } from "@/components/site/ui";
import { pageMetadata } from "@/lib/site/pages";

export const metadata = pageMetadata("/tools/contractor-vs-employee");

export default function Page() {
  return (
    <PageShell title="Contractor vs employee cost calculator" lead="Compare yearly cost. This does not decide how someone must be classified. It runs in your browser and nothing you enter is sent anywhere.">
      <ContractorVsEmployee />
    </PageShell>
  );
}
