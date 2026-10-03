"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export interface SwitcherBusiness { id: string; name: string; role: string }

/**
 * Cookie-based business switcher. The lead mounts it (e.g. in the Sidebar) with the user's businesses and the active id.
 * Renders nothing when the user belongs to a single business. The server re-checks membership before setting the cookie.
 */
export default function BusinessSwitcher({ businesses, activeId }: { businesses: SwitcherBusiness[]; activeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (businesses.length < 2) return null;

  async function change(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/team/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businessId: id }) });
      if (!r.ok) {
        setError("Could not switch business.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not switch business.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-xs">
      <label className="block text-slate-400" htmlFor="business-switcher">Business</label>
      <select
        id="business-switcher"
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-300 disabled:opacity-50"
        value={activeId}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      >
        {businesses.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.role})</option>)}
      </select>
      {error && <p role="alert" className="mt-1 text-red-300">{error}</p>}
    </div>
  );
}
