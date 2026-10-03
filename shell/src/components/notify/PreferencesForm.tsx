"use client";

import { useState } from "react";

export interface PrefsValue {
  inApp: boolean;
  email: boolean;
  weeklyBrief: boolean;
  quietTypes: string[];
}

export default function PreferencesForm({ initial, emailAvailable }: { initial: PrefsValue; emailAvailable: boolean }) {
  const [v, setV] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    setState("saving");
    try {
      const r = await fetch("/api/notifications/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
      setState(r.ok ? "saved" : "error");
    } catch {
      setState("error");
    }
  }

  const box = (key: "inApp" | "email" | "weeklyBrief", label: string, hint: string, disabled = false) => (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1" checked={v[key]} disabled={disabled} onChange={(e) => { setV({ ...v, [key]: e.target.checked }); setState("idle"); }} />
      <span>
        <span className="block">{label}</span>
        <span className="block text-xs text-slate-400">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-3">
      {box("inApp", "Show notifications in the app", "The bell and this page.")}
      {box("email", "Email me reminders", emailAvailable ? "Sent to your sign-in address. Turn this off any time." : "Email is not set up on this server yet, so nothing is sent. Your choice is saved for when it is.")}
      {box("weeklyBrief", "Email me the weekly brief", "Only sent if email is on above. The brief always appears here.")}
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={state === "saving"} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50">Save</button>
        <span role="status" className="text-xs text-slate-400">{state === "saved" ? "Saved." : state === "error" ? "Could not save. Try again." : ""}</span>
      </div>
    </div>
  );
}
