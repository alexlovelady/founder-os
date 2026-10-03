"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function FlagOverrideForm({ businessId, keys }: { businessId: string; keys: string[] }) {
  const router = useRouter();
  const [key, setKey] = useState(keys[0] ?? "");
  const [value, setValue] = useState<"on" | "off" | "remove">("on");
  const [msg, setMsg] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await fetch("/api/admin/flags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessId, key, enabled: value === "remove" ? null : value === "on" }),
        });
        setMsg(r.ok ? "Saved" : "Could not save");
        if (r.ok) router.refresh();
      }}
    >
      <label className="text-xs text-slate-400">Flag
        <select value={key} onChange={(e) => setKey(e.target.value)} className="mt-1 block rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-100">
          {keys.map((k) => <option key={k}>{k}</option>)}
        </select>
      </label>
      <label className="text-xs text-slate-400">Override
        <select value={value} onChange={(e) => setValue(e.target.value as typeof value)} className="mt-1 block rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-100">
          <option value="on">Force on</option><option value="off">Force off</option><option value="remove">Remove override</option>
        </select>
      </label>
      <button className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500">Apply</button>
      <span className="text-xs text-slate-400" role="status">{msg}</span>
    </form>
  );
}
