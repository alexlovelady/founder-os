import { getModule } from "@/config/modules";

export default function LegalPage() {
  const mod = getModule("legal")!;
  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <h1 className="font-medium">{mod.name}</h1>
        <a href="/legal-ui/" target="_blank" rel="noreferrer" className="text-sm text-slate-400 underline">
          Open in its own tab
        </a>
      </div>
      {/* LegalAI is its own deployment. The shell proxies it under /legal-ui, so this frame is same-origin and shares the sign-in. */}
      <iframe src="/legal-ui/" title={mod.name} className="min-h-0 flex-1 border-0" />
    </div>
  );
}
