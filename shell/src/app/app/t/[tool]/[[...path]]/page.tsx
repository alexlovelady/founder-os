import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { buildContext } from "@/lib/tools/context";
import { getTool } from "@/lib/tools/registry";

export const dynamic = "force-dynamic";

export default async function ToolPage({ params }: { params: Promise<{ tool: string; path?: string[] }> }) {
  const { tool: id, path = [] } = await params;
  const tool = getTool(id);
  if (!tool?.Page || tool.status !== "live") notFound();
  const session = await getSession();
  if (!session) redirect("/login");
  const ctx = await buildContext(session);
  if (!ctx) redirect("/app/onboarding");
  const Page = tool.Page;
  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="mb-1 text-2xl font-semibold">{tool.name}</h1>
      <p className="mb-6 text-sm text-slate-400">{tool.description}</p>
      <Page ctx={ctx} path={path} />
    </div>
  );
}
