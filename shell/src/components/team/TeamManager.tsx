"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ROLES, ROLE_LABEL, ROLE_SUMMARY, checkChangeRole, checkLeave, checkRemove, checkTransfer, invitableRoles, type Role } from "@/lib/team/permissions";

export interface MemberView { userId: string; role: Role; joinedAt: string; email: string; displayName: string; lastSeenAt: string | null }
export interface InviteView { id: string; role: Role; email: string | null; createdAt: string; expiresAt: string; maxUses: number; useCount: number; status: "active" | "expired" | "revoked" | "used" }

const btn = "rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-300 disabled:opacity-50";
const input = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-400";

export default function TeamManager(props: {
  meId: string;
  meRole: Role;
  members: MemberView[];
  invites: InviteView[];
  /** Seats in use / plan limit. `limit` null or omitted = unlimited / unknown. */
  seatLimit?: number | null;
}) {
  const router = useRouter();
  const { meId, meRole, members, invites } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [link, setLink] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState<Role>("member");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(1);

  const ownerCount = members.filter((m) => m.role === "owner").length;
  const canInviteRoles = invitableRoles(meRole);
  const seats = props.seatLimit ?? null;
  const seatsFull = seats !== null && members.length >= seats;

  async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) setError(typeof data.error === "string" ? data.error : "Something went wrong.");
      return { ok: r.ok, data };
    } catch {
      setError("Could not reach the server.");
      return { ok: false, data: {} };
    } finally {
      setBusy(false);
    }
  }

  async function createInvite(e: FormEvent) {
    e.preventDefault();
    setLink(undefined);
    setCopied(false);
    const r = await call("/api/team/invites", "POST", { role, email: email.trim() || undefined, expiresInDays: days, maxUses });
    if (r.ok && typeof r.data.path === "string") {
      setLink(`${window.location.origin}${r.data.path}`);
      setEmail("");
      router.refresh();
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setNotice("Copy failed. Select the link and copy it manually.");
    }
  }

  async function changeRole(userId: string, newRole: Role) {
    const r = await call(`/api/team/members/${encodeURIComponent(userId)}`, "PATCH", { role: newRole });
    if (r.ok) { setNotice("Role updated."); router.refresh(); }
  }

  async function remove(m: MemberView) {
    if (!window.confirm(`Remove ${m.displayName || m.email || m.userId} from this business?`)) return;
    const r = await call(`/api/team/members/${encodeURIComponent(m.userId)}`, "DELETE");
    if (r.ok) { setNotice("Member removed."); router.refresh(); }
  }

  async function transfer(m: MemberView) {
    if (!window.confirm(`Make ${m.displayName || m.email || m.userId} an owner and become an admin yourself? Only they can undo this.`)) return;
    const r = await call("/api/team/transfer", "POST", { userId: m.userId });
    if (r.ok) { setNotice("Ownership transferred."); router.refresh(); }
  }

  async function leave() {
    if (!window.confirm("Leave this business? You will lose access to its data.")) return;
    const r = await call("/api/team/leave", "POST");
    if (r.ok) { router.replace("/app/dashboard"); router.refresh(); }
  }

  async function revoke(id: string) {
    const r = await call(`/api/team/invites/${id}`, "DELETE");
    if (r.ok) { setNotice("Invite revoked."); router.refresh(); }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="space-y-8">
      <div role="status" aria-live="polite" className="min-h-5 text-sm">
        {error && <p className="rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-red-200" role="alert">{error}</p>}
        {!error && notice && <p className="text-emerald-300">{notice}</p>}
      </div>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="members-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="members-h" className="font-medium">Members</h2>
          <span className={`rounded px-2 py-0.5 text-xs ${seatsFull ? "bg-amber-900 text-amber-200" : "bg-slate-800 text-slate-300"}`}>
            {seats === null ? `${members.length} ${members.length === 1 ? "member" : "members"}` : `${members.length} of ${seats} seats used`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">People with access to this business</caption>
            <thead className="text-xs text-slate-400">
              <tr><th scope="col" className="py-2 pr-3 font-normal">Person</th><th scope="col" className="py-2 pr-3 font-normal">Role</th><th scope="col" className="py-2 pr-3 font-normal">Joined</th><th scope="col" className="py-2 font-normal"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {members.map((m) => {
                const isMe = m.userId === meId;
                const roleOptions = ROLES.filter((r) => r === m.role || checkChangeRole({ actorRole: meRole, actorId: meId, targetRole: m.role, targetId: m.userId, newRole: r, ownerCount }).ok);
                const editable = roleOptions.length > 1;
                const canRemove = checkRemove({ actorRole: meRole, actorId: meId, targetRole: m.role, targetId: m.userId, ownerCount }).ok;
                const canTransfer = checkTransfer({ actorRole: meRole, actorId: meId, targetRole: m.role, targetId: m.userId }).ok;
                const canLeave = isMe && checkLeave(m.role, ownerCount).ok;
                const name = m.displayName || m.email || m.userId;
                return (
                  <tr key={m.userId}>
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{name}{isMe && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}</div>
                      {(m.displayName && m.email) && <div className="text-xs text-slate-400">{m.email}</div>}
                      {!m.displayName && !m.email && <div className="text-xs text-slate-500">Not seen yet. Their name appears after they next open the app.</div>}
                    </td>
                    <td className="py-2.5 pr-3">
                      {editable ? (
                        <select aria-label={`Role of ${name}`} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm" value={m.role} disabled={busy} onChange={(e) => changeRole(m.userId, e.target.value as Role)}>
                          {roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      ) : <span className="rounded bg-slate-800 px-2 py-0.5 text-xs">{ROLE_LABEL[m.role]}</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-400">{fmt(m.joinedAt)}</td>
                    <td className="py-2.5 text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canTransfer && <button className={btn} disabled={busy} onClick={() => transfer(m)}>Make owner</button>}
                        {canRemove && <button className={btn} disabled={busy} onClick={() => remove(m)}>Remove</button>}
                        {canLeave && <button className={btn} disabled={busy} onClick={leave}>Leave</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-1 pt-2 text-xs text-slate-400 sm:grid-cols-2">
          {ROLES.map((r) => <div key={r}><dt className="inline font-medium text-slate-300">{ROLE_LABEL[r]}: </dt><dd className="inline">{ROLE_SUMMARY[r]}</dd></div>)}
        </dl>
      </section>

      {canInviteRoles.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="invite-h">
          <h2 id="invite-h" className="font-medium">Invite someone</h2>
          <p className="text-sm text-slate-400">
            Invitees need a FounderOS (LegalAI) account first. For now accounts are created by the administrator, so ask them to get one before they open the link.
            No email is sent: copy the link and share it yourself.
          </p>
          {seatsFull && <p className="rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-200">All seats on your plan are in use. New people cannot join until you free a seat or upgrade.</p>}
          <form onSubmit={createInvite} className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">Role
              <select className={input} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {canInviteRoles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </label>
            <label className="block text-sm">Only this email may accept (optional)
              <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="off" />
            </label>
            <label className="block text-sm">Expires after
              <select className={input} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} {d === 1 ? "day" : "days"}</option>)}
              </select>
            </label>
            <label className="block text-sm">Number of people who can use it
              <input className={input} type="number" min={1} max={50} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <p className="text-xs text-slate-400 sm:col-span-2">{ROLE_SUMMARY[role]}</p>
            <div className="sm:col-span-2"><button className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50" disabled={busy}>Create invite link</button></div>
          </form>
          {link && (
            <div className="space-y-2 rounded-lg border border-emerald-900 bg-emerald-950/50 p-3" role="region" aria-label="New invite link">
              <p className="text-sm text-emerald-200">Copy this link now. For security it is shown only once and cannot be recovered. If you lose it, revoke it and create another.</p>
              <div className="flex gap-2">
                <input readOnly aria-label="Invite link" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" value={link} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className={btn} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <p className="text-sm text-slate-400">Only owners and admins can invite people.</p>
      )}

      {canInviteRoles.length > 0 && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="pending-h">
          <h2 id="pending-h" className="font-medium">Invites</h2>
          {invites.length === 0 ? <p className="text-sm text-slate-400">No invites yet.</p> : (
            <ul className="divide-y divide-slate-800">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div>
                    <span className="font-medium">{ROLE_LABEL[i.role]}</span>
                    {i.email && <span className="text-slate-400"> for {i.email}</span>}
                    <div className="text-xs text-slate-400">
                      Created {fmt(i.createdAt)}, {i.status === "active" ? `expires ${fmt(i.expiresAt)}` : i.status}, used {i.useCount} of {i.maxUses}
                    </div>
                  </div>
                  {i.status === "active" && <button className={btn} disabled={busy} onClick={() => revoke(i.id)} aria-label={`Revoke ${ROLE_LABEL[i.role]} invite created ${fmt(i.createdAt)}`}>Revoke</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
