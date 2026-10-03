export type SignupMode = "closed" | "invite" | "open";

/** SIGNUP_MODE: closed (default; anything unrecognised is closed), invite, open. Read at call time so tests and deploys can change it. */
export function signupMode(env: Record<string, string | undefined> = process.env): SignupMode {
  const v = (env.SIGNUP_MODE ?? "").trim().toLowerCase();
  return v === "invite" || v === "open" ? v : "closed";
}

/** The shared secret for LegalAI's private provisioning endpoint. Server-side only: never send it to a browser or log it. */
export function provisionToken(env: Record<string, string | undefined> = process.env): string {
  return (env.INTERNAL_PROVISION_TOKEN ?? "").trim();
}

export const signupAvailable = (env: Record<string, string | undefined> = process.env): boolean => provisionToken(env).length >= 32;

export const legalUrl = (env: Record<string, string | undefined> = process.env): string => (env.LEGAL_URL ?? "http://localhost:8000").replace(/\/+$/, "");
