/** Plain strength hint for the signup form. Pure, used in the browser and on the server. Length is what matters most; this is a hint, not a score. */
export const MIN_PASSWORD = 12;

export interface PasswordHint { level: "short" | "weak" | "ok" | "strong"; message: string }

const COMMON = /^(password|passw0rd|qwerty|letmein|welcome|admin|iloveyou|123456|abcdef|founderos)/i;

export function passwordHint(pw: string): PasswordHint {
  if (pw.length < MIN_PASSWORD) return { level: "short", message: `Use at least ${MIN_PASSWORD} characters (${MIN_PASSWORD - pw.length} more).` };
  if (new Set(pw).size < 5 || COMMON.test(pw)) return { level: "weak", message: "Easy to guess. Avoid common words and repeated characters." };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 || classes >= 3) return { level: "strong", message: "Good. A long passphrase of several words works well." };
  return { level: "ok", message: "Acceptable. Longer is better: try a passphrase of several unrelated words." };
}

/** Server-side extra check beyond length: refuse a password that is just the email address or its local part. */
export function passwordProblem(pw: string, email: string): string | null {
  const p = pw.toLowerCase();
  const e = email.toLowerCase();
  if (p === e || p === e.split("@")[0]) return "The password cannot be your email address.";
  if (new Set(pw).size < 4) return "That password is too easy to guess.";
  return null;
}
