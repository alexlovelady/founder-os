import { TODO, toItems } from "./sop";

export const DOC_KINDS = ["sop", "proposal", "quote", "policy", "checklist", "job_description", "onboarding", "meeting_agenda", "business_overview", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const KIND_LABEL: Record<DocKind, string> = {
  sop: "SOP", proposal: "Proposal", quote: "Quote", policy: "Policy", checklist: "Checklist", job_description: "Job description",
  onboarding: "Onboarding", meeting_agenda: "Meeting agenda", business_overview: "Business overview", other: "Other",
};

/** Kinds that have a fill-in template. */
export const TEMPLATE_KINDS = ["proposal", "quote", "policy", "checklist", "job_description", "onboarding", "meeting_agenda"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface FieldDef { key: string; label: string; multiline?: boolean; hint?: string }
export const FIELD_DEFS: Record<TemplateKind, FieldDef[]> = {
  proposal: [
    { key: "client", label: "Client or company" }, { key: "project", label: "Project / service" },
    { key: "problem", label: "Their need or problem", multiline: true }, { key: "scope", label: "What you will do (one per line)", multiline: true },
    { key: "timeline", label: "Timeline" }, { key: "price", label: "Price or fee (as you want it written)" }, { key: "terms", label: "Payment terms" },
  ],
  quote: [
    { key: "client", label: "Customer" }, { key: "reference", label: "Quote reference / job" },
    { key: "items", label: "Line items, one per line: description | quantity | unit price", multiline: true, hint: "Install faucet | 2 | 85.50" },
    { key: "taxPct", label: "Sales tax % (leave blank if none)" }, { key: "validDays", label: "Valid for (days)" }, { key: "notes", label: "Notes", multiline: true },
  ],
  policy: [
    { key: "policyName", label: "Policy name" }, { key: "purpose", label: "Purpose", multiline: true }, { key: "scope", label: "Who it applies to" },
    { key: "rules", label: "The rules (one per line)", multiline: true }, { key: "consequences", label: "What happens if it is not followed", multiline: true },
  ],
  checklist: [{ key: "name", label: "Checklist name" }, { key: "items", label: "Items (one per line)", multiline: true }],
  job_description: [
    { key: "role", label: "Job title" }, { key: "type", label: "Employment type (full-time, part-time, contractor)" }, { key: "reportsTo", label: "Reports to" },
    { key: "responsibilities", label: "Responsibilities (one per line)", multiline: true }, { key: "requirements", label: "Requirements (one per line)", multiline: true },
    { key: "pay", label: "Pay range" },
  ],
  onboarding: [
    { key: "who", label: "Who is being onboarded (new employee, new customer)" }, { key: "name", label: "Name (optional)" },
    { key: "before", label: "Before day one (one per line)", multiline: true }, { key: "first", label: "First day / first week (one per line)", multiline: true },
    { key: "after", label: "First month (one per line)", multiline: true },
  ],
  meeting_agenda: [
    { key: "meeting", label: "Meeting name" }, { key: "date", label: "Date and time" }, { key: "attendees", label: "Attendees" },
    { key: "topics", label: "Topics, one per line (optionally: topic | minutes)", multiline: true }, { key: "goal", label: "Goal of the meeting" },
  ],
};

export interface BizProfile { name: string; industry?: string; city?: string; state?: string; website?: string; entityType?: string }

const v = (x: string | undefined) => (x ?? "").trim();
const or = (x: string | undefined) => v(x) || TODO;
const list = (x: string | undefined, mark = "- ") => {
  const it = toItems(v(x));
  return it.length ? it.map((s) => `${mark}${s}`).join("\n") : TODO;
};
const numbered = (x: string | undefined) => {
  const it = toItems(v(x));
  return it.length ? it.map((s, n) => `${n + 1}. ${s}`).join("\n") : TODO;
};
const place =(b: BizProfile) => [b.city, b.state].filter(Boolean).join(", ");

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Parse "description | qty | unit price" lines and total them. Totals are computed here, never trusted from a browser. */
export function quoteTotals(items: string, taxPct: string) {
  const lines: { description: string; qty: number; unit: number; total: number }[] = [];
  const bad: string[] = [];
  for (const raw of toItems(items)) {
    const parts = raw.split("|").map((p) => p.trim());
    const qty = Number((parts[1] ?? "").replace(/[, ]/g, ""));
    const unit = Number((parts[2] ?? "").replace(/[$, ]/g, ""));
    if (parts.length < 3 || !parts[0] || !Number.isFinite(qty) || !Number.isFinite(unit) || qty < 0 || unit < 0) { bad.push(raw); continue; }
    lines.push({ description: parts[0], qty, unit, total: Math.round(qty * unit * 100) / 100 });
  }
  const subtotal = Math.round(lines.reduce((a, l) => a + l.total, 0) * 100) / 100;
  const rate = Math.min(100, Math.max(0, Number(v(taxPct)) || 0));
  const tax = Math.round(subtotal * rate) / 100;
  return { lines, bad, subtotal, taxPct: rate, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

export function generateDocument(kind: TemplateKind, f: Record<string, string>, biz: BizProfile, date: string): { title: string; body: string; kind: TemplateKind } {
  const head = (extra: string[] = []) => [`**${biz.name}**`, ...[place(biz), biz.website ? v(biz.website) : ""].filter(Boolean), ...extra].join("  \n");
  switch (kind) {
    case "proposal": {
      const title = `Proposal: ${v(f.project) || "[●PROJECT]"} for ${v(f.client) || "[●CLIENT]"}`;
      return { kind, title, body: `# ${title}\n\n${head([`Date: ${date}`])}\n\n## Understanding of your needs\n${or(f.problem)}\n\n## What we will do\n${list(f.scope)}\n\n## Timeline\n${or(f.timeline)}\n\n## Investment\n${or(f.price)}\n\n## Payment terms\n${or(f.terms)}\n\n## Next steps\n1. Review this proposal and tell us about any changes.\n2. Confirm in writing to accept.\n3. We schedule the start date together.\n\n## Acceptance\nClient name: ${TODO}  \nSignature and date: ${TODO}\n` };
    }
    case "quote": {
      const q = quoteTotals(f.items ?? "", f.taxPct ?? "");
      const title = `Quote${v(f.reference) ? ` ${v(f.reference)}` : ""} for ${v(f.client) || "[●CUSTOMER]"}`;
      const rows = q.lines.length ? q.lines.map((l) => `- ${l.description}: ${l.qty} x ${money(l.unit)} = ${money(l.total)}`).join("\n") : TODO;
      const extra = q.bad.length ? `\n\n> Could not read these lines (use description | quantity | unit price): ${q.bad.join("; ")}` : "";
      const days = Number(v(f.validDays));
      return { kind, title, body: `# ${title}\n\n${head([`Date: ${date}`])}\n\n## Items\n${rows}${extra}\n\n## Totals\n- Subtotal: ${money(q.subtotal)}\n${q.taxPct > 0 ? `- Sales tax (${q.taxPct}%): ${money(q.tax)}\n` : ""}- **Total: ${money(q.total)}**\n\n## Terms\nThis quote is valid for ${Number.isFinite(days) && days > 0 ? days : "[●DAYS]"} days from ${date}.\n\n## Notes\n${v(f.notes) || "None."}\n` };
    }
    case "policy": {
      const title = v(f.policyName) || "[●POLICY NAME]";
      return { kind, title, body: `# ${title}\n\n${biz.name}  \nEffective: ${date}  \nReview: yearly\n\n## Purpose\n${or(f.purpose)}\n\n## Who this applies to\n${or(f.scope)}\n\n## Policy\n${numbered(f.rules)}\n\n## If this policy is not followed\n${or(f.consequences)}\n\n> This is a business template, not legal advice. Have it reviewed where the law requires specific wording.\n` };
    }
    case "checklist": {
      const title = v(f.name) || "[●CHECKLIST NAME]";
      return { kind, title, body: `# ${title}\n\n${toItems(v(f.items)).length ? list(f.items, "- [ ] ") : TODO}\n` };
    }
    case "job_description": {
      const title = `Job description: ${v(f.role) || "[●JOB TITLE]"}`;
      return { kind, title, body: `# ${title}\n\n${biz.name}${place(biz) ? `, ${place(biz)}` : ""}\n\n- Type: ${or(f.type)}\n- Reports to: ${or(f.reportsTo)}\n- Pay: ${or(f.pay)}\n\n## About ${biz.name}\n${v(biz.industry) ? `${biz.name} works in ${v(biz.industry)}.` : "[●ONE SENTENCE ABOUT THE BUSINESS]"}\n\n## Responsibilities\n${list(f.responsibilities)}\n\n## Requirements\n${list(f.requirements)}\n\n## How to apply\n${TODO}\n\n> Review pay, classification and wording against your state's employment rules before posting.\n` };
    }
    case "onboarding": {
      const who = v(f.who) || "new team member";
      const title = `Onboarding checklist: ${v(f.name) || who}`;
      return { kind, title, body: `# ${title}\n\n${biz.name}  \nStarted: ${date}\n\n## Before day one\n${list(f.before, "- [ ] ")}\n\n## First day and first week\n${list(f.first, "- [ ] ")}\n\n## First month\n${list(f.after, "- [ ] ")}\n` };
    }
    case "meeting_agenda": {
      const title = `Agenda: ${v(f.meeting) || "[●MEETING]"}`;
      const topics = toItems(f.topics ?? "").map((t) => { const [name, mins] = t.split("|").map((x) => x.trim()); return `1. ${name}${mins ? ` (${mins} min)` : ""}`; });
      return { kind, title, body: `# ${title}\n\n- When: ${or(f.date)}\n- Attendees: ${or(f.attendees)}\n- Goal: ${or(f.goal)}\n\n## Agenda\n${topics.length ? topics.map((t, n) => t.replace(/^1\./, `${n + 1}.`)).join("\n") : TODO}\n\n## Decisions\n${TODO}\n\n## Action items\n- [ ] ${TODO}\n` };
    }
  }
}
