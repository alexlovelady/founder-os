import { z } from "zod";
import type { Sql } from "@founderos/sdk";
import { recordAudit } from "@/lib/platform/audit";
import { purgeBusinessRows } from "@/lib/platform/privacy";
import { checkAndRecord, hashIp, hashSubject, type Env } from "./limits";
import { legalCall, userPath } from "./legal";
import type { LifecycleDeps } from "./reset";

export const DeleteInput = z.object({
  confirmEmail: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(256),
});

export type DeleteAccountResult =
  | { ok: true; summary: { businessesDeleted: number; membershipsRemoved: number } }
  | { ok: false; status: 400 | 403 | 409 | 429 | 502 | 503; message: string; blockedBusinesses?: string[] };

interface Plan { businessId: string; name: string; action: "delete" | "leave" | "blocked" }

/**
 * Delete the signed-in person's account. `user` comes from the verified session, never from the request.
 *  1. The typed email must equal the account email, and the current password is re-checked in LegalAI (no session is created).
 *  2. In one transaction with the businesses locked: a business where the person is the only owner but others are members blocks everything
 *     (nothing is changed; they must transfer ownership or delete the team first). A business where they are the only member is deleted with all its
 *     tool data (same code as "delete business"); in any other business only their membership is removed.
 *  3. LegalAI deletes the account (sessions revoked, email anonymized, MFA removed, solely-owned matters and their files purged).
 *  4. Personal rows in the shell are removed. Audit rows stay (they carry only the pseudonymous user id).
 * If step 3 fails, steps 1-2 are already done; the person can sign in again (their session is still valid) and repeat. The route does not need a business.
 */
export async function deleteAccount(sql: Sql, user: { id: string; email: string }, raw: unknown, deps: LifecycleDeps): Promise<DeleteAccountResult> {
  const env: Env = deps.env ?? process.env;
  const parsed = DeleteInput.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, message: "Type your email address and your current password to confirm." };
  if (parsed.data.confirmEmail.toLowerCase() !== user.email.trim().toLowerCase()) {
    return { ok: false, status: 400, message: "The email address you typed does not match your account." };
  }
  const lim = await checkAndRecord(sql, "delete", hashIp(deps.ip, env), hashSubject(`user:${user.id}`, env));
  if (!lim.ok) return { ok: false, status: 429, message: "Too many attempts. Please wait an hour and try again." };

  const check = await legalCall("POST", userPath(user.id, "/verify-password"), { password: parsed.data.password }, deps);
  if (!check || check.status !== 200) return { ok: false, status: 503, message: "We could not check your password right now. Please try again in a few minutes." };
  if (check.json.ok !== true) return { ok: false, status: 403, message: "That password is not correct." };
  if (check.json.last_admin === true) {
    return { ok: false, status: 409, message: "You are the only platform administrator. Make another person an administrator before deleting this account." };
  }

  const outcome = await sql.begin(async (tx): Promise<{ blocked: string[] } | { deleted: number; left: number }> => {
    const rows = await tx<{ business_id: string; role: string; name: string }[]>`
      SELECT m.business_id, m.role, b.name FROM business_members m JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = ${user.id} ORDER BY m.business_id FOR UPDATE OF b`;
    const plans: Plan[] = [];
    for (const r of rows) {
      const [c] = await tx<{ members: number; other_owners: number }[]>`
        SELECT count(*)::int AS members, count(*) FILTER (WHERE role = 'owner' AND user_id <> ${user.id})::int AS other_owners
        FROM business_members WHERE business_id = ${r.business_id}`;
      const sole = c.members <= 1;
      plans.push({ businessId: r.business_id, name: r.name, action: sole ? "delete" : r.role === "owner" && c.other_owners === 0 ? "blocked" : "leave" });
    }
    const blocked = plans.filter((p) => p.action === "blocked");
    if (blocked.length) return { blocked: blocked.map((p) => p.name) };
    let deleted = 0;
    let left = 0;
    for (const p of plans) {
      if (p.action === "delete") {
        await recordAudit(tx as unknown as Sql, { businessId: null, userId: user.id, action: "account.business.delete", meta: { deletedBusinessId: p.businessId } });
        await purgeBusinessRows(tx as unknown as Sql, p.businessId);
        deleted++;
      } else {
        await tx`DELETE FROM business_members WHERE business_id = ${p.businessId} AND user_id = ${user.id}`;
        await tx`DELETE FROM team_member_profiles WHERE business_id = ${p.businessId} AND user_id = ${user.id}`;
        left++;
      }
    }
    return { deleted, left };
  });
  if ("blocked" in outcome) {
    return {
      ok: false, status: 409, blockedBusinesses: outcome.blocked,
      message: `You are the only owner of ${outcome.blocked.map((n) => `"${n}"`).join(", ")}, which has other members. Transfer ownership to someone else or remove the other members first, then try again.`,
    };
  }

  const gone = await legalCall("DELETE", userPath(user.id), undefined, deps);
  if (!gone || gone.status !== 200) {
    await recordAudit(sql, { businessId: null, userId: user.id, action: "account.delete_incomplete", meta: { legalStatus: gone?.status ?? 0 } });
    return {
      ok: false, status: 502,
      message: "Your business data was removed, but we could not finish deleting your sign-in account. Nothing else is needed from you: sign in again and repeat this to finish.",
    };
  }
  await purgeShellUserData(sql, user);
  await recordAudit(sql, { businessId: null, userId: user.id, action: "account.deleted", resource: { tool: "platform", id: user.id }, meta: { businessesDeleted: outcome.deleted, membershipsRemoved: outcome.left } });
  return { ok: true, summary: { businessesDeleted: outcome.deleted, membershipsRemoved: outcome.left } };
}

/**
 * Personal rows the shell keeps outside any business. Each statement is independent and best effort (a missing optional table must not
 * stop the others). audit_events keep the pseudonymous user id; tool tables keep `created_by` ids in businesses the person left.
 */
export async function purgeShellUserData(sql: Sql, user: { id: string; email: string }): Promise<void> {
  const email = user.email.trim().toLowerCase();
  const steps: (() => Promise<unknown>)[] = [
    () => sql`DELETE FROM team_member_profiles WHERE user_id = ${user.id}`,
    () => sql`DELETE FROM notification_preferences WHERE user_id = ${user.id}`,
    () => sql`DELETE FROM notifications WHERE user_id = ${user.id}`,
    () => sql`DELETE FROM feedback WHERE user_id = ${user.id}`,
    () => sql`UPDATE analytics_events SET user_id = NULL WHERE user_id = ${user.id}`,
    () => sql`UPDATE usage_events SET user_id = NULL WHERE user_id = ${user.id}`,
    () => sql`DELETE FROM platform_suspensions WHERE user_id = ${user.id}`,
    () => sql`DELETE FROM password_reset_tokens WHERE user_id = ${user.id}`,
    () => sql`DELETE FROM email_verifications WHERE user_id = ${user.id}`,
    // every queued, sent or failed email addressed to the person (it holds the address and, for lifecycle mail, a link)
    () => sql`DELETE FROM email_outbox WHERE lower(to_email) = ${email}`,
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      console.error("account deletion cleanup step failed", (e as { code?: string }).code ?? "");
    }
  }
}
