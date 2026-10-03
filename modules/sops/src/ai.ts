import { SOP_SECTIONS } from "./sop";

export const AI_ACTIONS = ["draft_sop", "improve", "expand", "polish"] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export const AI_SYSTEM = `You write clear, practical small-business documents.
Rules:
- Ground everything in the business description provided. Do not invent names, numbers, prices, dates, licences, or legal claims.
- Where you lack a fact, write [●PLACEHOLDER] with a short hint inside, e.g. [●PHONE NUMBER], for the owner to fill in.
- Output ONLY the document in markdown. No introduction, no closing remarks, no code fences.
- Plain language, short sentences, numbered steps in the imperative.`;

const STRUCTURE = `Use exactly these sections as "## " headings under a "# Title" line: ${SOP_SECTIONS.join(", ")}. Put steps as a numbered list under Procedure and quality checks as "- [ ]" items. Keep the Revision History as a single line for the initial version.`;

export function buildPrompt(action: AiAction, businessText: string, input: { process?: string; notes?: string; body?: string; kind?: string }): string {
  const biz = `ABOUT THE BUSINESS\n${businessText}\n`;
  switch (action) {
    case "draft_sop":
      return `${biz}\nTASK: Draft a standard operating procedure for: ${input.process ?? ""}\n${input.notes ? `Extra detail from the owner:\n${input.notes}\n` : ""}${STRUCTURE}`;
    case "improve":
      return `${biz}\nTASK: Improve this SOP. Fix unclear or missing steps, make each step one clear action, add missing standard sections, keep the owner's meaning, and add [●PLACEHOLDER] where information is missing. ${STRUCTURE}\n${input.notes ? `Owner's request: ${input.notes}\n` : ""}\nCURRENT SOP\n${input.body ?? ""}`;
    case "expand":
      return `${biz}\nTASK: Expand this SOP with more detail: break big steps into sub-steps, add quality checks, exceptions, and escalation. Do not invent facts; use [●PLACEHOLDER] for what is unknown. ${STRUCTURE}\n${input.notes ? `Owner's request: ${input.notes}\n` : ""}\nCURRENT SOP\n${input.body ?? ""}`;
    case "polish":
      return `${biz}\nTASK: Polish this ${input.kind ?? "document"} for tone and clarity. Keep its structure, facts and every [●PLACEHOLDER]; do not add new facts or numbers.\n\nDOCUMENT\n${input.body ?? ""}`;
  }
}

/** Strip chatter and code fences the model may wrap around a document. */
export function cleanAiText(text: string): string {
  let t = text.replace(/\r\n?/g, "\n").trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  const lines = t.split("\n");
  const firstDoc = lines.findIndex((l) => /^#{1,3}\s/.test(l));
  if (firstDoc > 0 && firstDoc <= 3) lines.splice(0, firstDoc);
  while (lines.length && /^(let me know|i hope this|feel free|would you like|hope this helps)/i.test(lines[lines.length - 1].trim())) lines.pop();
  while (lines.length && /^---+\s*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join("\n").trim();
}
