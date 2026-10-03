export type Frequency = "none" | "quarterly" | "yearly";

export function detectKeywords(titles: string[]) {
  const has = (re: RegExp) => titles.some((t) => re.test(t));
  return {
    hasCustomerOnboarding: has(/\b(customer|client)\b.*\bonboard/i) || has(/\bonboard.*\b(customer|client)\b/i),
    hasIncidentPlan: has(/\b(incident|emergency|breach|disaster)\b/i),
    hasBackupPlan: has(/\b(backup|back-up|recovery|continuity)\b/i),
  };
}

const dayOnly = (d: string) => d.slice(0, 10);

/** The date a document is next due for review, or null when it has no review cycle. */
export function nextReviewDate(freq: Frequency, lastReviewed: string | null, createdAt: string): string | null {
  if (freq === "none") return null;
  const base = new Date(`${dayOnly(lastReviewed ?? createdAt)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCMonth(base.getUTCMonth() + (freq === "quarterly" ? 3 : 12));
  return base.toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);
