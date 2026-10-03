/**
 * Server-side check for fabricated-looking marketing claims. AI is told to use [●PLACEHOLDER] for facts it was not given; this catches
 * numbers, testimonials, guarantees and superlatives in its output that do not appear anywhere in what the user supplied.
 * It is a heuristic safety net, not proof: the owner must still read every draft.
 */
export interface Flag { kind: "number" | "percentage" | "money" | "rating" | "testimonial" | "guarantee" | "superlative"; text: string; message: string }

const PLACEHOLDER = /\[●[^\]]*\]/g;
const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
const digits = (s: string) => s.replace(/[^\d.]/g, "").replace(/\.$/, "");

function numbersIn(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) set.add(digits(m[0]));
  return set;
}

export function checkClaims(output: string, sources: string[]): Flag[] {
  const text = output.replace(PLACEHOLDER, " ");
  const src = norm(sources.join("\n"));
  const known = numbersIn(src);
  const flags: Flag[] = [];
  const seen = new Set<string>();
  const add = (f: Flag) => { const k = `${f.kind}:${norm(f.text)}`; if (!seen.has(k)) { seen.add(k); flags.push(f); } };
  const unsupported = (n: string) => !known.has(digits(n));

  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s?%/g)) if (unsupported(m[0])) add({ kind: "percentage", text: m[0].trim(), message: "A percentage you did not provide" });
  for (const m of text.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?/g)) if (unsupported(m[0])) add({ kind: "money", text: m[0], message: "A price or dollar amount you did not provide" });
  for (const m of text.matchAll(/\b\d+(?:\.\d)?\s?(?:-|\s)?stars?\b|★+/gi)) if (!/star/i.test(src) || unsupported(m[0])) add({ kind: "rating", text: m[0], message: "A rating you did not provide" });
  for (const m of text.matchAll(/\b\d[\d,]*\+?\s+(?:years?|customers?|clients?|reviews?|projects?|homes?|jobs?|businesses|families|happy|satisfied|five-star)\b/gi)) {
    if (unsupported(m[0].split(/\s/)[0])) add({ kind: "number", text: m[0], message: "A statistic you did not provide" });
  }
  for (const m of text.matchAll(/\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    const prefix = text.slice(Math.max(0, (m.index ?? 0) - 1), m.index);
    if (prefix === "$" || (n >= 1900 && n <= 2100) || !unsupported(m[0])) continue;
    add({ kind: "number", text: m[0], message: "A large number you did not provide" });
  }
  for (const m of text.matchAll(/["“]([^"”]{20,})["”]\s*(?:[-—–]\s*[A-Z]|,?\s*(?:said|says))|(?:said|says|raves|told us)[:,]?\s*["“]([^"”]{10,})["”]/g)) {
    const quote = norm(m[1] ?? m[2] ?? "");
    if (!src.includes(quote)) add({ kind: "testimonial", text: (m[1] ?? m[2]).slice(0, 80), message: "A customer quote you did not provide" });
  }
  const word = (re: RegExp, kind: Flag["kind"], message: string) => {
    for (const m of text.matchAll(re)) if (!src.includes(norm(m[0]))) add({ kind, text: m[0], message });
  };
  word(/\b(?:guarantee[ds]?|money[- ]back|risk[- ]free)\b/gi, "guarantee", "A guarantee you did not state");
  word(/(?:#1|\bnumber one\b|\bbest in\b|\baward[- ]winning\b|\btop[- ]rated\b|\bvoted best\b)/gi, "superlative", "A ranking or award claim you did not state");
  return flags;
}

export const FLAG_NOTE = "These claims look invented. Replace them with real facts you can back up, or delete them, before you publish.";
