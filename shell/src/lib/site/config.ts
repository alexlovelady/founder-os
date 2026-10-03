/** Site-wide constants for the public pages. Copy for each page lives in its page file; this holds only shared values. */

function resolveBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;
  return "http://localhost:3000";
}

export const SITE = {
  name: "FounderOS",
  tagline: "Your back office for starting and running a business",
  baseUrl: resolveBaseUrl(),
  /** Hidden everywhere when unset. Set NEXT_PUBLIC_CONTACT_EMAIL to show it on /contact and /security. */
  contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || undefined,
  /** Shown on the draft legal pages. Update it whenever the text of /terms, /privacy or /ai-disclosure changes. */
  legalLastUpdated: "2026-10-03",
  legalLastUpdatedLabel: "October 3, 2026",
} as const;

export const NOT_A_FIRM =
  "FounderOS provides software tools and general information. It is not a law firm, an accounting firm, or a financial adviser, and nothing here is legal, tax, accounting or financial advice.";

export const NOT_ADVICE_SHORT =
  "General information only, not legal, tax or financial advice. Check important decisions with a qualified professional.";
