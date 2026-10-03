import FlagsEditor from "@/components/platform/FlagsEditor";
import { db } from "@/lib/db";
import { listFlags } from "@/lib/platform/flags";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function AdminFlags() {
  await requireAdminPage();
  const flags = await listFlags(db());
  return (
    <>
      <h1 className="text-2xl font-semibold">Feature flags</h1>
      <p className="text-sm text-slate-400">A flag is on for a business when it is enabled and the business falls inside the rollout percentage. Per-business overrides (set on the business page) always win. Changes are audited.</p>
      <FlagsEditor flags={flags} />
    </>
  );
}
