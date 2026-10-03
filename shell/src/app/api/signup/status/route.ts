import { signupAvailable, signupMode } from "@/lib/signup/config";

export const dynamic = "force-dynamic";

/** Public: tells the login and signup pages whether to offer signup. Reveals only the mode and whether it is configured, never a secret. */
export async function GET() {
  return Response.json({ mode: signupMode(), available: signupAvailable() }, { headers: { "cache-control": "no-store" } });
}
