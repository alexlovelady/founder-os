import { getModule } from "@/config/modules";

export default function LegalPage() {
  const mod = getModule("legal")!;
  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <h1 className="font-medium">{mod.name}</h1>
        <a href={mod.baseUrl} target="_blank" rel="noreferrer" className="text-sm text-slate-400 underline">Open in its own tab</a>
      </div>
      {/* The module is its own deployment, shown here in a frame. It only loads if it lists this site in EMBED_ORIGINS. */}
      <iframe src={mod.baseUrl} title={mod.name} className="min-h-0 flex-1 border-0" />
    </div>
  );
}
