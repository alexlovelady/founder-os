import { cookies } from "next/headers";
import type { SessionUser } from "./provider";

const LEGAL = process.env.LEGAL_URL ?? "http://localhost:8000";

/** Server-side session check. Authorization is decided here, never by hiding things in the browser. */
export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!cookie) return null;
  try {
    const r = await fetch(`${LEGAL}/api/auth/me`, { headers: { cookie }, cache: "no-store" });
    if (!r.ok) return null;
    const { user } = await r.json();
    return { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
  } catch {
    return null;
  }
}
