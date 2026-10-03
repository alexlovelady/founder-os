import type { ScanResult } from "./scanner";

export const AI_LABEL = "AI-generated analysis, check against sources. Suggestions to review with a professional, not legal advice.";

export const SYSTEM_PROMPT = [
  "You help a small-business founder understand the software product they have built, from a structured scan of its code repository.",
  "Use ONLY the scan evidence and business context provided. If something is not in the evidence, say it is unknown; never invent facts.",
  "Word conclusions as 'appears to' or 'likely'. Every item must cite the evidence it rests on (file path, dependency or detected signal).",
  "Legal items are suggestions to review with a professional, not legal advice.",
].join(" ");

/** The structured scan, reduced to what the model needs. Excerpts are short and were stored for exactly this purpose. */
export function scanEvidence(r: ScanResult): string {
  const a = r.analysis;
  const lines: string[] = [];
  lines.push(`Repository: ${r.url} (fetched ${r.scannedAt.slice(0, 10)})`);
  lines.push(`Description from the host: ${r.meta.description ?? "none"}; topics: ${r.meta.topics.join(", ") || "none"}`);
  lines.push(`License of the repository: ${a.repoLicense ?? "none found"}. Visibility: ${r.meta.private == null ? "unknown" : r.meta.private ? "private" : "public"}. Archived: ${r.meta.archived}.`);
  lines.push(`Languages: ${r.languages.map((l) => `${l.name} ${l.pct}%`).join(", ") || "unknown"}`);
  lines.push(`Frameworks: ${a.frameworks.join(", ") || "none detected"}. Databases: ${a.databases.join(", ") || "none detected"}.`);
  lines.push(`Third-party services detected: ${a.services.map((s) => `${s.name} [${s.category}] (${s.evidence[0]})`).join("; ") || "none detected"}`);
  const s = a.signals;
  for (const [k, v] of Object.entries(s)) lines.push(`Signal ${k}: ${v.value ? "appears true" : "not seen"}${v.evidence.length ? ` (evidence: ${v.evidence.join("; ")})` : ""}`);
  lines.push(`Maturity: ${Object.entries(a.maturity).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push(`Activity: ${r.activity.commitsLast90d ?? "unknown"}${r.activity.commitsCapped ? "+" : ""} commits in the last 90 days, last commit ${r.activity.lastCommitAt?.slice(0, 10) ?? "unknown"}, contributors ${r.activity.contributors ?? "unknown"}${r.activity.contributorsCapped ? "+" : ""}.`);
  if (a.declaredLicenses.length) lines.push(`Licenses declared in manifests: ${a.declaredLicenses.map((l) => `${l.license} (${l.file})`).join("; ")}`);
  if (a.copyleftHints.length) lines.push(`Packages with copyleft/AGPL terms: ${a.copyleftHints.map((c) => `${c.name}: ${c.note}`).join("; ")}`);
  lines.push(`Top-level files: ${r.tree.topLevel.map((t) => t.path + (t.type === "tree" ? "/" : "")).join(", ")}`);
  for (const f of r.files) {
    if (f.kind === "env") lines.push(`--- ${f.path} (variable names only)\n${f.excerpt}`);
    else lines.push(`--- ${f.path}${f.truncated ? " (excerpt)" : ""}\n${f.excerpt.slice(0, f.kind === "readme" ? 3500 : 700)}`);
  }
  return lines.join("\n");
}

export function buildPrompt(scan: ScanResult, businessText: string): string {
  return `${businessText}

SCAN OF THE PRODUCT'S CODE REPOSITORY (the only source of truth)
${scanEvidence(scan)}

Write the analysis in this exact format.
First line: "SUMMARY: " followed by ONE plain sentence (under 300 characters) saying what this product is and who it is for.
Then these headings, each followed by short bullet points. Each bullet ends with "(evidence: ...)" naming the file, dependency or signal it rests on.
## What it is and who it is for
## Main features
## How it likely makes money
## Maturity
## Business and legal implications to review
For the last heading consider, only where the evidence supports it: privacy policy or terms of service likely needed (accounts, personal data), payment processor terms, data protection rules for health or children's data, open-source license obligations, third-party service agreements, and cookie or analytics consent. State these as items to review with a professional.
Say "unknown from the scan" rather than guessing.`;
}

/** The one-line summary the model was asked to lead with, or null. */
export function extractSummaryLine(text: string): string | null {
  const m = /^\s*SUMMARY:\s*(.+)$/im.exec(text);
  return m ? m[1].trim().slice(0, 300) : null;
}

/** A plain description from facts alone, used when there is no AI summary. */
export function deterministicProfile(r: ScanResult): string {
  const a = r.analysis;
  const bits: string[] = [];
  bits.push(`Repository ${r.owner}/${r.name}${r.meta.description ? `: ${r.meta.description}` : ""}.`);
  const stack = [...a.languages.slice(0, 3), ...a.frameworks.slice(0, 3), ...a.databases.slice(0, 2)];
  if (stack.length) bits.push(`Stack: ${stack.join(", ")}.`);
  const flags: string[] = [];
  if (a.signals.handlesUserAccounts.value) flags.push("user accounts");
  if (a.signals.handlesPayments.value) flags.push("payments");
  if (a.signals.appearsToCollectPersonalData.value) flags.push("personal data");
  if (flags.length) bits.push(`It appears to involve ${flags.join(", ")}.`);
  return bits.join(" ");
}
