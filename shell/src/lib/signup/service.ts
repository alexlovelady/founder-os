import { z } from "zod";
import type { Sql } from "@founderos/sdk";
import { recordAudit } from "@/lib/platform/audit";
import { consumeCode, restoreCode } from "./codes";
import { legalUrl, provisionToken, signupMode, type SignupMode } from "./config";
import { checkAndRecordAttempt, hashId, setOutcome, type Outcome } from "./limits";
import { MIN_PASSWORD, passwordProblem } from "./password";
import { emailConfigured } from "@/lib/lifecycle/mail";
import { startVerification } from "@/lib/lifecycle/verify";

export const SignupInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(320, "That email address is too long.")),
  password: z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters for the password.`).max(256, "That password is too long."),
  displayName: z.string().trim().min(1, "Enter your name.").max(200, "That name is too long."),
  code: z.string().trim().max(100, "That invite code is not valid.").optional(),
  acceptTerms: z.literal(true, { error: "You need to accept the terms to create an account." }),
});
export type SignupInput = z.infer<typeof SignupInput>;

export type SignupResult =
  | { ok: true; next: string }
  | { ok: false; status: 400 | 403 | 409 | 429 | 503; message: string };

export interface SignupDeps {
  sql: Sql;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Raw client IP (see clientIp). Hashed before it is stored. */
  ip: string;
  /** Injectable for tests: sends what the verification email put in the outbox. Default: run the outbox with the configured provider. */
  flush?: () => Promise<unknown>;
}

const fail = (status: Extract<SignupResult, { ok: false }>["status"], message: string): SignupResult => ({ ok: false, status, message });
const UNAVAILABLE = "Signup is not available right now. Please try again later.";
export const OPEN_NEEDS_EMAIL = "Open signup needs email verification, which is not configured. Ask the administrator.";

type Provision = { kind: "created"; id: string } | { kind: "duplicate" } | { kind: "invalid" } | { kind: "unavailable" };

/** Server-to-server call to LegalAI's private endpoint. The token is sent only here, only server side; nothing is logged. */
async function provision(input: SignupInput, deps: SignupDeps, unverified: boolean): Promise<Provision> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  let r: Response;
  try {
    r = await doFetch(`${legalUrl(env)}/api/internal/users`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": provisionToken(env) },
      // `active: false` is only sent for open signup (the account is created inactive until the email is confirmed); other modes keep the old body.
      body: JSON.stringify({ email: input.email, password: input.password, display_name: input.displayName, ...(unverified ? { active: false } : {}) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (r.status === 200) {
    const d = (await r.json().catch(() => null)) as { id?: unknown } | null;
    return typeof d?.id === "string" ? { kind: "created", id: d.id } : { kind: "unavailable" };
  }
  if (r.status === 409) return { kind: "duplicate" };
  if (r.status === 422) return { kind: "invalid" };
  return { kind: "unavailable" }; // 401 (token mismatch), 404 (not enabled there), 429, 5xx: the user cannot fix these
}

/**
 * Self-serve signup. Order: mode, configuration, validation, rate limit, take one use of the invite code, create the account in LegalAI.
 * If the account is not created the code use is given back. No session is created: the person signs in afterwards.
 */
export async function signup(raw: unknown, deps: SignupDeps): Promise<SignupResult> {
  const env = deps.env ?? process.env;
  const mode: SignupMode = signupMode(env);
  if (mode === "closed") return fail(403, "Sign-up is by invitation only. Ask the FounderOS administrator for access.");
  if (provisionToken(env).length < 32) return fail(503, "Signup is not available.");
  // Open signup must never run unverified: without a working email setup it refuses to accept anyone.
  if (mode === "open" && !emailConfigured(env)) return fail(503, OPEN_NEEDS_EMAIL);

  const parsed = SignupInput.safeParse(raw);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const input = parsed.data;
  const pw = passwordProblem(input.password, input.email);
  if (pw) return fail(400, pw);
  if (mode === "invite" && !input.code) return fail(400, "Enter your invite code.");

  const sql = deps.sql;
  const ipHash = hashId("ip", deps.ip, env);
  const emailHash = hashId("email", input.email, env);
  const lim = await checkAndRecordAttempt(sql, ipHash, emailHash);
  if (!lim.ok) return fail(429, "Too many sign-up attempts. Please wait an hour and try again.");
  const attemptId = lim.attemptId!;
  const done = async (o: Outcome) => setOutcome(sql, attemptId, o);

  let codeId: string | null = null;
  if (mode === "invite") {
    codeId = await consumeCode(sql, input.code!);
    if (!codeId) {
      await done("invalid_code");
      return fail(400, "That invite code is not valid, has expired, or has been used up.");
    }
  }
  const giveBack = async () => {
    if (!codeId) return;
    try {
      await restoreCode(sql, codeId);
    } catch {
      console.error("signup: could not restore invite code use");
    }
  };

  let p: Provision;
  try {
    p = await provision(input, deps, mode === "open");
  } catch {
    p = { kind: "unavailable" };
  }
  if (p.kind === "created") {
    await done("created");
    // Never put the email, name, password or code in the audit metadata.
    await recordAudit(sql, { businessId: null, userId: p.id, action: "signup.created", resource: { tool: "platform", id: p.id }, meta: { mode, withInviteCode: Boolean(codeId), verificationRequired: mode === "open" } });
    if (mode === "open") {
      // The account exists but is inactive. The link goes out by email; the address is not kept with the token. If queuing fails the person can use "resend".
      await startVerification(sql, p.id, input.email, { env, flush: deps.flush });
      return { ok: true, next: "/verify?sent=1" };
    }
    return { ok: true, next: "/login?created=1" };
  }
  await giveBack();
  if (p.kind === "duplicate") {
    await done("duplicate");
    return fail(409, "An account with this email already exists. Try signing in instead.");
  }
  if (p.kind === "invalid") {
    await done("failed");
    return fail(400, "Check your details and try again.");
  }
  await done("unavailable");
  return fail(503, UNAVAILABLE);
}
