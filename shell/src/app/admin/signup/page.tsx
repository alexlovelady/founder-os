import CodesManager from "@/components/signup/CodesManager";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/platform/http";
import { listCodes } from "@/lib/signup/codes";
import { signupAvailable, signupMode } from "@/lib/signup/config";
import { recentAttemptStats } from "@/lib/signup/limits";

export const dynamic = "force-dynamic";

export default async function AdminSignup() {
  await requireAdminPage();
  const sql = db();
  const [codes, stats] = await Promise.all([listCodes(sql), recentAttemptStats(sql)]);
  const mode = signupMode();
  const available = signupAvailable();
  return (
    <>
      <h1 className="text-2xl font-semibold">Sign-up</h1>
      <div className="space-y-1 text-sm text-slate-300">
        <p>Mode: <span className="font-mono text-white">{mode}</span> (set with the SIGNUP_MODE environment variable: closed, invite or open).</p>
        <p>Provisioning link to LegalAI: {available ? "configured" : <span className="text-amber-300">not configured (set INTERNAL_PROVISION_TOKEN, 32+ characters, on both services). Sign-up returns 503.</span>}</p>
        {mode === "open" && (
          <p role="alert" className="rounded-lg border border-amber-700 bg-amber-950 p-2 text-amber-200">
            Open mode lets anyone create an account and email addresses are not verified. Keep it off until email verification exists.
          </p>
        )}
      </div>
      <h2 className="text-lg font-semibold">Invite codes</h2>
      <p className="text-sm text-slate-400">Codes are used when the mode is invite. Only a hash is stored, so the code is shown once. Creating and revoking codes is audited.</p>
      <CodesManager codes={codes} />
      <h2 className="text-lg font-semibold">Attempts in the last 24 hours</h2>
      {stats.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
        <ul className="text-sm text-slate-300">{stats.map((s) => <li key={s.outcome}>{s.outcome}: {s.n}</li>)}</ul>
      )}
      <p className="text-xs text-slate-500">Attempts store keyed hashes of the IP address and email, never the raw values.</p>
    </>
  );
}
