import { cookies } from "next/headers";
import { db } from "../db";
import { isSuspended } from "../admin/suspensions";
import type { SessionUser } from "./provider";

const LEGAL = process.env.LEGAL_URL ?? "http://localhost:8000";

export interface Session {
  user: SessionUser;
  /** The caller's cookie header, forwarded when the shell acts on their behalf toward a module. */
  cookie: string;
  /** Module CSRF token for that session (interim identity provider). */
  csrf: string;
}

/** Server-side session check. Authorization is decided here, never by hiding things in the browser. */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!cookie) return null;
  try {
    const r = await fetch(`${LEGAL}/api/auth/me`, { headers: { cookie }, cache: "no-store" });
    if (!r.ok) return null;
    const { user, csrf_token } = await r.json();
    // A platform admin can suspend a user here; their LegalAI session may still be valid, so the shell refuses it.
    if (await isSuspended(db(), user.id)) return null;
    return { user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role }, cookie, csrf: csrf_token };
  } catch {
    return null;
  }
}
