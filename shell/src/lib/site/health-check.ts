/**
 * Business health check for the public site: a short questionnaire evaluated entirely in the browser.
 * There is deliberately no numeric score. Each category is "complete", "needs attention" or "missing" (or "not applicable"), and
 * the items behind it are listed so the owner sees what to do. It is a prompt for thinking, not an assessment of the business.
 */

export const CATEGORIES = ["Legal", "Compliance", "Finance", "Operations", "Sales", "Security"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Answer = "yes" | "partly" | "no" | "na";
export type CategoryStatus = "complete" | "attention" | "missing" | "not_applicable";

export interface HealthItem {
  id: string;
  category: Category;
  question: string;
  /** Shown when the answer is not "yes". */
  todo: string;
}

export const ITEMS: HealthItem[] = [
  { id: "structure", category: "Legal", question: "The business has a chosen legal structure (or you have decided to operate as a sole proprietor).", todo: "Decide on and set up a legal structure." },
  { id: "contracts", category: "Legal", question: "Customer and contractor work is covered by written agreements.", todo: "Put written agreements in place for customers and contractors." },
  { id: "ip", category: "Legal", question: "Anyone who built your product, brand or content has signed something confirming you own it.", todo: "Check who owns the work people created for you and document it." },
  { id: "registered", category: "Compliance", question: "The business is registered where it operates (state, and city or county if required).", todo: "Check state and local registration requirements." },
  { id: "licenses", category: "Compliance", question: "You have checked which licenses or permits your field and location require.", todo: "Look up licenses and permits for your field and location." },
  { id: "taxfilings", category: "Compliance", question: "You know your recurring tax and annual filing dates and track them.", todo: "List your filing deadlines and set reminders." },
  { id: "bank", category: "Finance", question: "Business money runs through a separate business bank account.", todo: "Open a separate business account." },
  { id: "bookkeeping", category: "Finance", question: "Income and expenses are recorded regularly (not only at tax time).", todo: "Start recording income and expenses on a regular schedule." },
  { id: "runway", category: "Finance", question: "You know your monthly spending and how many months your cash would last.", todo: "Calculate your burn and runway (the free runway calculator can help)." },
  { id: "sops", category: "Operations", question: "Key recurring processes are written down so someone else could follow them.", todo: "Write down your most important repeated processes." },
  { id: "docs", category: "Operations", question: "Important documents are kept in one organized place, not scattered across inboxes.", todo: "Gather key documents into one organized place." },
  { id: "tasks", category: "Operations", question: "Deadlines and to-dos are tracked somewhere you check regularly.", todo: "Set up one list for deadlines and tasks." },
  { id: "pricing", category: "Sales", question: "Your prices are based on your costs and a margin you chose.", todo: "Work out your costs and set prices from a target margin." },
  { id: "pipeline", category: "Sales", question: "You keep track of customers, leads and follow-ups.", todo: "Keep a simple record of leads, customers and next steps." },
  { id: "terms", category: "Sales", question: "Customers see your terms (and a privacy policy if you collect their data) before they buy or sign up.", todo: "Prepare customer terms and a privacy policy, ideally reviewed by a lawyer." },
  { id: "passwords", category: "Security", question: "Business accounts use unique passwords in a password manager.", todo: "Move business accounts to unique passwords in a password manager." },
  { id: "mfa", category: "Security", question: "Two-step sign-in is on for email, banking and other critical accounts.", todo: "Turn on two-step sign-in for email, banking and key services." },
  { id: "backups", category: "Security", question: "Important business data is backed up somewhere separate, and you have tried restoring it.", todo: "Set up backups and test a restore." },
];

export type Answers = Record<string, Answer | undefined>;

export interface CategoryResult {
  category: Category;
  status: CategoryStatus;
  /** Number of applicable items answered "yes" and how many applicable items there are. Shown as a fraction, never as a score. */
  covered: number;
  applicable: number;
  /** Items to act on (answer "no" or "partly"). */
  todos: { id: string; text: string; answer: "no" | "partly" }[];
  /** Applicable items not yet answered. */
  unanswered: number;
}

/** Status per category. Unanswered items count as unanswered (never as covered). */
export function evaluate(answers: Answers): CategoryResult[] {
  return CATEGORIES.map((category) => {
    const items = ITEMS.filter((i) => i.category === category);
    const applicable = items.filter((i) => answers[i.id] !== "na");
    const yes = applicable.filter((i) => answers[i.id] === "yes").length;
    const no = applicable.filter((i) => answers[i.id] === "no").length;
    const unanswered = applicable.filter((i) => answers[i.id] === undefined).length;
    const todos = applicable
      .filter((i) => answers[i.id] === "no" || answers[i.id] === "partly")
      .map((i) => ({ id: i.id, text: i.todo, answer: answers[i.id] as "no" | "partly" }));
    let status: CategoryStatus;
    if (applicable.length === 0) status = "not_applicable";
    else if (yes === applicable.length) status = "complete";
    else if (no === applicable.length) status = "missing";
    else status = "attention";
    return { category, status, covered: yes, applicable: applicable.length, todos, unanswered };
  });
}

export const STATUS_LABEL: Record<CategoryStatus, string> = {
  complete: "Complete",
  attention: "Needs attention",
  missing: "Missing",
  not_applicable: "Not applicable",
};
