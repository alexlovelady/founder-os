import Link from "next/link";
import RuleEditor from "@/components/admin/compliance/RuleEditor";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function NewComplianceRule() {
  await requireAdminPage();
  return (
    <>
      <Link href="/admin/compliance" className="text-sm text-slate-400 underline">All compliance rules</Link>
      <h1 className="text-2xl font-semibold">New rule (saved as a draft)</h1>
      <p className="text-sm text-slate-400">A draft reaches no business. To publish you need an https source and a last-verified date. Only add content you can point to an official source for.</p>
      <RuleEditor rule={null} versions={[]} />
    </>
  );
}
