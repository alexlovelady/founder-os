/**
 * Deterministic document classifier (spec 17 steps 5-6). It suggests a category and document type from the extracted text and the filename,
 * and returns the phrases it matched so the user can judge the suggestion. It is a keyword heuristic, not a legal reading of the document,
 * and a suggestion is never applied without the user's click.
 */
import type { Category } from "./facts";

export interface Suggestion {
  category: Category;
  docType: string;
  confidence: "high" | "medium";
  /** The phrases that triggered the suggestion (from the text or the filename). */
  evidence: string[];
}

interface Signal {
  re: RegExp;
  /** 4 = a defining phrase (usually a title), 2 = supporting, 1 = weak. */
  w: number;
}
interface Rule {
  docType: string;
  category: Category;
  signals: Signal[];
  /** Filename hints, worth a fixed 3 points. */
  filename?: RegExp;
}

const s = (re: RegExp, w: number): Signal => ({ re, w });

export const RULES: Rule[] = [
  {
    docType: "operating agreement", category: "Formation",
    filename: /operating[ _-]?agreement|llc[ _-]?agreement/i,
    signals: [s(/\b(limited liability company )?operating agreement\b/i, 4), s(/\bmembers?\b/i, 1), s(/\bcapital contributions?\b/i, 2), s(/\bmanaging member\b/i, 2), s(/\bmember-managed|manager-managed\b/i, 2), s(/\bdistributions?\b/i, 1)],
  },
  {
    docType: "articles of organization", category: "Formation",
    filename: /articles[ _-]?of[ _-]?(organization|incorporation)|certificate[ _-]?of[ _-]?(formation|incorporation)/i,
    signals: [s(/\barticles of (organization|incorporation)\b/i, 4), s(/\bcertificate of (formation|incorporation)\b/i, 4), s(/\bsecretary of state\b/i, 2), s(/\bregistered agent\b/i, 2), s(/\bfiled\b/i, 1)],
  },
  {
    docType: "bylaws", category: "Formation",
    filename: /by-?laws/i,
    signals: [s(/\bbylaws\b/i, 4), s(/\bboard of directors\b/i, 2), s(/\bshareholders?\b|\bstockholders?\b/i, 1), s(/\bannual meeting\b/i, 2)],
  },
  {
    docType: "EIN letter", category: "Taxes",
    filename: /\bein\b|cp[ _-]?575|ss-?4/i,
    signals: [s(/\bCP ?575\b/i, 4), s(/\bemployer identification number\b/i, 3), s(/\binternal revenue service\b/i, 2), s(/\bwe assigned you an ein\b|\bassigned (you )?an? EIN\b/i, 4), s(/\b\d{2}-\d{7}\b/, 1)],
  },
  {
    docType: "W-9", category: "Taxes",
    filename: /\bw-?9\b/i,
    signals: [s(/\bform w-?9\b/i, 4), s(/request for taxpayer identification number/i, 4), s(/\bcertification\b/i, 1)],
  },
  {
    docType: "tax return", category: "Taxes",
    filename: /tax[ _-]?return|\b1120-?s?\b|\b1065\b|\bschedule c\b|\b1040\b/i,
    signals: [s(/\bform (1120-?s?|1065|1040|941)\b/i, 4), s(/\bu\.?s\.? (corporation|partnership|individual) income tax return\b/i, 4), s(/\btaxable income\b/i, 2), s(/\bdepartment of the treasury\b/i, 2)],
  },
  {
    docType: "NDA", category: "Contracts",
    filename: /\bnda\b|non-?disclosure|confidentiality[ _-]?agreement/i,
    signals: [s(/\bnon-?disclosure agreement\b/i, 4), s(/\bconfidentiality agreement\b/i, 4), s(/\bmutual (non-?disclosure|confidentiality)\b/i, 4), s(/\bconfidential information\b/i, 2), s(/\bdisclosing party\b/i, 2), s(/\breceiving party\b/i, 2)],
  },
  {
    docType: "independent contractor agreement", category: "Contractors",
    filename: /contractor|consulting[ _-]?agreement|1099/i,
    signals: [s(/\bindependent contractor (services )?agreement\b/i, 4), s(/\bcontractor services agreement\b/i, 4), s(/\bconsulting agreement\b/i, 3), s(/\bindependent contractor\b/i, 2), s(/\bnot an employee\b|\bnot employees\b/i, 2), s(/\bscope of (work|services)\b/i, 1)],
  },
  {
    docType: "employment agreement", category: "Employees",
    filename: /employment[ _-]?agreement|offer[ _-]?letter/i,
    signals: [s(/\bemployment agreement\b/i, 4), s(/\boffer letter\b/i, 3), s(/\boffer of employment\b/i, 3), s(/\bat-?will\b/i, 2), s(/\b(base )?salary\b/i, 1), s(/\bemployee handbook\b/i, 2), s(/\bnon-?compete\b/i, 1)],
  },
  {
    docType: "privacy policy", category: "Policies",
    filename: /privacy/i,
    signals: [s(/\bprivacy (policy|notice|statement)\b/i, 4), s(/\bpersonal (information|data)\b/i, 2), s(/\bcookies?\b/i, 1), s(/\bwe collect\b/i, 2), s(/\bthird[- ]part(y|ies)\b/i, 1), s(/\bccpa\b|\bgdpr\b/i, 2)],
  },
  {
    docType: "terms of service", category: "Policies",
    filename: /terms[ _-]?(of[ _-]?(service|use)|and[ _-]?conditions)|\btos\b/i,
    signals: [s(/\bterms of (service|use)\b/i, 4), s(/\bterms and conditions\b/i, 4), s(/\bacceptable use\b/i, 2), s(/\byou agree to (be bound|these terms)\b/i, 2), s(/\blimitation of liability\b/i, 1)],
  },
  {
    docType: "insurance policy", category: "Insurance",
    filename: /insurance|\bpolicy\b|\bcoi\b|certificate[ _-]?of[ _-]?insurance/i,
    signals: [s(/\bcertificate of (liability )?insurance\b/i, 4), s(/\b(general|professional|commercial) liability\b/i, 3), s(/\bpolicy (number|period|no\.?)\b/i, 3), s(/\bdeclarations page\b/i, 4), s(/\binsured\b/i, 1), s(/\bpremium\b/i, 1), s(/\bcoverage\b/i, 1), s(/\bworkers'? compensation\b/i, 2)],
  },
  {
    docType: "lease", category: "Contracts",
    filename: /\blease\b|rental[ _-]?agreement/i,
    signals: [s(/\b(commercial |office |residential )?lease agreement\b/i, 4), s(/\blandlord\b/i, 2), s(/\btenant\b/i, 2), s(/\bsecurity deposit\b/i, 2), s(/\bpremises\b/i, 1), s(/\bmonthly rent\b|\bbase rent\b/i, 2)],
  },
  {
    docType: "master services agreement", category: "Contracts",
    filename: /\bmsa\b|master[ _-]?services?|services?[ _-]?agreement/i,
    signals: [s(/\bmaster services agreement\b/i, 4), s(/\bservices agreement\b/i, 3), s(/\bstatement of work\b|\bSOW\b/, 2), s(/\bservice levels?\b/i, 1), s(/\bindemnif/i, 1), s(/\bgoverning law\b/i, 1)],
  },
  {
    docType: "invoice", category: "Finance",
    filename: /invoice|\binv[ _-]?\d/i,
    signals: [s(/\binvoice (number|no\.?|#|date)\b/i, 4), s(/^\s*invoice\b/im, 3), s(/\bbill to\b/i, 2), s(/\bamount due\b|\bbalance due\b/i, 2), s(/\bdue date\b/i, 1)],
  },
  {
    docType: "standard operating procedure", category: "SOPs",
    filename: /\bsop\b|procedure/i,
    signals: [s(/\bstandard operating procedure\b/i, 4), s(/\bscope\b/i, 1),s(/\bstep \d\b/i, 1), s(/\bprocedure\b/i, 2)],
  },
];

const THRESHOLD = 5;
const HEAD_CHARS = 1500;
const BODY_CHARS = 200_000;

/** True when only whitespace or heading marks come before `idx` on its line. */
const opensLine = (t: string, idx: number) => /^[\s#*_>-]*$/.test(t.slice(t.lastIndexOf("\n", idx - 1) + 1, idx));

/** Suggest a category and document type, or null when nothing matches strongly enough. */
export function classify(text: string, filename: string): Suggestion | null {
  const body = text.slice(0, BODY_CHARS);
  const scored: { rule: Rule; score: number; evidence: string[] }[] = [];
  for (const rule of RULES) {
    let score = 0;
    const evidence: string[] = [];
    if (rule.filename?.test(filename)) {
      score += text.trim() ? 3 : 5; // with no readable text the filename is all there is
      evidence.push(`filename "${filename.slice(0, 80)}"`);
    }
    for (const sig of rule.signals) {
      const m = sig.re.exec(body);
      if (!m) continue;
      // A defining phrase that opens a line near the top is a title (worth more); the same words inside a sentence are only a mention.
      score += sig.w >= 3 && m.index < HEAD_CHARS && opensLine(body, m.index) ? sig.w + 2 : sig.w;
      if (sig.w >= 2) evidence.push(`"${m[0].replace(/\s+/g, " ").trim().slice(0, 60)}"`);
    }
    if (score >= THRESHOLD) scored.push({ rule, score, evidence });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const [top, next] = scored;
  if (next && next.score === top.score) return null; // a tie is not a suggestion
  return {
    category: top.rule.category,
    docType: top.rule.docType,
    confidence: top.score >= 8 && (!next || top.score >= next.score * 1.5) ? "high" : "medium",
    evidence: [...new Set(top.evidence)].slice(0, 5),
  };
}

/** Whether the document already carries this suggestion, so the chip is not shown for something the user has set. */
export function alreadyApplied(s: Suggestion, current: { category: string; docType: string }): boolean {
  return current.category === s.category && current.docType.trim().toLowerCase() === s.docType.toLowerCase();
}
