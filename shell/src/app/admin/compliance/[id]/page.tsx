import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdminRule } from "@founderos/compliance/src/admin-rules";
import { SLUG_RE } from "@founderos/compliance/src/rule-schema";
import RuleEditor from "@/components/admin/compliance/RuleEditor";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function EditComplianceRule({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  if (!SLUG_RE.test(id)) notFound();
  const found = await getAdminRule(db(), id);
  if (!found) notFound();
  const { rule, versions } = found;
  return (
    <>
      <Link href="/admin/compliance" className="text-sm text-slate-400 underline">All compliance rules</Link>
      <h1 className="text-2xl font-semibold">{rule.content.title}</h1>
      <p className="font-mono text-xs text-slate-500">{rule.ruleId} · v{rule.version} · {rule.status}</p>
      <p className="text-sm text-slate-400">Editing a published rule creates a new version; untouched checklist items get the new wording at the next sync. Disabling removes untouched items that came only from this rule. Items people have changed are never removed.</p>
      {/* key forces the form to reset when a save/restore bumps the version */}
      <RuleEditor key={`${rule.version}-${rule.updatedAt}`} rule={rule} versions={versions} />
    </>
  );
}
