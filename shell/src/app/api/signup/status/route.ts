import { emailConfigured } from "@/lib/lifecycle/mail";
import { signupAvailable, signupMode } from "@/lib/signup/config";

export const dynamic = "force-dynamic";

/** Public: tells the login and signup pages whether to offer signup. Reveals only the mode and whether it is configured, never a secret. */
export async function GET() {
  const mode = signupMode();
  // Open signup needs email verification: without a working email setup it is not offered at all.
  return Response.json({ mode, available: signupAvailable() && (mode !== "open" || emailConfigured()) }, { headers: { "cache-control": "no-store" } });
}
