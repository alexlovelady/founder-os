export const TODO = "[●TO FILL IN]";

export interface SopInput {
  name: string;
  goal: string;
  performer: string;
  /** One per line, or comma separated. */
  tools: string;
  inputs: string;
  /** One step per line; leading numbers and bullets are ignored. */
  steps: string;
  exceptions: string;
  result: string;
  frequency: string;
  prerequisites: string;
  qualityChecks: string;
  escalation: string;
}

export const EMPTY_SOP: SopInput = { name: "", goal: "", performer: "", tools: "", inputs: "", steps: "", exceptions: "", result: "", frequency: "", prerequisites: "", qualityChecks: "", escalation: "" };

export const SOP_SECTIONS = ["Purpose", "Owner", "Frequency", "Required Tools", "Prerequisites", "Procedure", "Quality Checks", "Exceptions", "Escalation", "Revision History"] as const;

/** Split free text into clean items: one per line (or comma separated when there is a single line), bullets and numbering removed. */
export function toItems(text: string): string[] {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return [];
  let parts = t.split("\n");
  if (parts.length === 1 && t.includes(",")) parts = t.split(",");
  return parts.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
}

const bullets = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : TODO);

/** Deterministic SOP formatter: no AI involved. The same input always yields the same document. */
export function formatSop(i: Partial<SopInput>, meta: { date: string; author?: string } = { date: "" }): { title: string; body: string } {
  const s: SopInput = { ...EMPTY_SOP, ...i };
  const title = s.name.trim() || "Untitled procedure";
  const steps = toItems(s.steps);
  const tools = toItems(s.tools);
  const inputs = toItems(s.inputs);
  const prereq = [...toItems(s.prerequisites), ...inputs.map((x) => `Have ready: ${x}`)];
  const checks = toItems(s.qualityChecks);
  if (checks.length === 0 && s.result.trim()) checks.push(`Expected result achieved: ${s.result.trim()}`);
  const purpose = [s.goal.trim(), s.result.trim() && s.goal.trim() ? `Expected result: ${s.result.trim()}` : s.result.trim()].filter(Boolean).join("\n\n") || TODO;
  const exceptions = toItems(s.exceptions);
  const sections: [string, string][] = [
    ["Purpose", purpose],
    ["Owner", s.performer.trim() || TODO],
    ["Frequency", s.frequency.trim() || TODO],
    ["Required Tools", bullets(tools)],
    ["Prerequisites", bullets(prereq)],
    ["Procedure", steps.length ? steps.map((x, n) => `${n + 1}. ${x}`).join("\n") : TODO],
    ["Quality Checks", checks.length ? checks.map((x) => `- [ ] ${x}`).join("\n") : TODO],
    ["Exceptions", bullets(exceptions)],
    ["Escalation", s.escalation.trim() || TODO],
    ["Revision History", `- v1${meta.date ? ` (${meta.date})` : ""}: Initial version${meta.author ? ` by ${meta.author}` : ""}`],
  ];
  return { title, body: `# ${title}\n\n${sections.map(([h, b]) => `## ${h}\n${b}`).join("\n\n")}\n` };
}

/** Which of the standard sections a markdown body is missing (used to nudge the author). */
export function missingSections(body: string): string[] {
  return SOP_SECTIONS.filter((h) => !new RegExp(`^#{1,3}\\s*${h}\\b`, "im").test(body));
}
