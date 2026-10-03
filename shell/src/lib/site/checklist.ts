/**
 * Startup checklist: a small branching questionnaire that turns answers into a list of generic steps with links to official sources.
 * Pure functions, no network. Every link below was checked to return HTTP 200 on 2026-10-03; re-check before adding more.
 * It is general information for US businesses, not advice: rules vary by state, city and industry.
 */

export interface ChecklistQuestion {
  id: QuestionId;
  label: string;
  options: { value: string; label: string }[];
}

export type QuestionId = "structure" | "employees" | "contractors" | "sells" | "location";
export type Answers = Partial<Record<QuestionId, string>>;

export const QUESTIONS: ChecklistQuestion[] = [
  {
    id: "structure",
    label: "Where are you with a legal structure?",
    options: [
      { value: "not_formed", label: "I have not formed a business yet" },
      { value: "sole", label: "Sole proprietor (no separate entity)" },
      { value: "entity", label: "LLC or corporation" },
    ],
  },
  {
    id: "employees",
    label: "Do you have, or plan to hire, employees?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  {
    id: "contractors",
    label: "Do you pay freelancers or contractors?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  {
    id: "sells",
    label: "Do you sell physical goods or taxable services?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "unsure", label: "Not sure" },
    ],
  },
  {
    id: "location",
    label: "Will you operate from a physical location, or in a licensed field?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No, online and unlicensed" },
      { value: "unsure", label: "Not sure" },
    ],
  },
];

export interface SourceLink {
  label: string;
  href: string;
}

export interface ChecklistStep {
  id: string;
  title: string;
  why: string;
  links: SourceLink[];
}

const SBA = "https://www.sba.gov/business-guide";
const IRS = "https://www.irs.gov/businesses/small-businesses-self-employed";

export const LINKS = {
  ein: { label: "IRS: Get an Employer Identification Number", href: `${IRS}/get-an-employer-identification-number` },
  sbaGuide: { label: "SBA: Business guide", href: SBA },
  structure: { label: "SBA: Choose a business structure", href: `${SBA}/launch-your-business/choose-business-structure` },
  irsStructures: { label: "IRS: Business structures", href: `${IRS}/business-structures` },
  register: { label: "SBA: Register your business", href: `${SBA}/launch-your-business/register-your-business` },
  licenses: { label: "SBA: Apply for licenses and permits", href: `${SBA}/launch-your-business/apply-licenses-permits` },
  taxIds: { label: "SBA: Get federal and state tax ID numbers", href: `${SBA}/launch-your-business/get-federal-state-tax-id-numbers` },
  bank: { label: "SBA: Open a business bank account", href: `${SBA}/launch-your-business/open-business-bank-account` },
  plan: { label: "SBA: Write your business plan", href: `${SBA}/plan-your-business/write-your-business-plan` },
  estimated: { label: "IRS: Estimated taxes", href: `${IRS}/estimated-taxes` },
  employmentTaxes: { label: "IRS: Employment taxes", href: `${IRS}/employment-taxes` },
  i9: { label: "USCIS: Form I-9, Employment Eligibility Verification", href: "https://www.uscis.gov/i-9" },
  contractor: { label: "IRS: Independent contractor, self-employed or employee?", href: `${IRS}/independent-contractor-self-employed-or-employee` },
  stateSites: { label: "IRS: State government websites", href: `${IRS}/state-government-websites` },
} as const satisfies Record<string, SourceLink>;

export const ALL_CHECKLIST_LINKS: SourceLink[] = Object.values(LINKS);

/** Which steps appear for a set of answers. Unanswered questions are treated conservatively: the step is shown. */
export function buildChecklist(a: Answers): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  const notFormed = a.structure === "not_formed" || a.structure === undefined;
  const hasEmployees = a.employees === "yes";

  if (notFormed) {
    steps.push({ id: "plan", title: "Write down what the business is and how it will make money", why: "A short plan clarifies costs, customers and what you need before you spend money.", links: [LINKS.plan] });
    steps.push({ id: "structure", title: "Choose a legal structure", why: "The structure affects personal liability, taxes and paperwork. A lawyer or accountant can tell you which fits your situation.", links: [LINKS.structure, LINKS.irsStructures] });
    steps.push({ id: "register", title: "Register the business with your state and locality", why: "Forming an entity, or registering a business name, is handled by your state and sometimes your city or county.", links: [LINKS.register, LINKS.stateSites] });
  }

  if (notFormed || a.structure === "entity" || hasEmployees) {
    steps.push({ id: "ein", title: "Get an Employer Identification Number (EIN) if you need one", why: "Entities and businesses with employees generally need an EIN. It is free from the IRS directly.", links: [LINKS.ein] });
  } else if (a.structure === "sole") {
    steps.push({ id: "ein-check", title: "Check whether you need an EIN", why: "Some sole proprietors with no employees can use their own tax ID, but a business bank account or other needs may call for an EIN. It is free from the IRS directly.", links: [LINKS.ein] });
  }

  if (a.location !== "no") {
    steps.push({ id: "licenses", title: "Check licenses and permits for your location and field", why: "Requirements depend on your industry, city, county and state.", links: [LINKS.licenses, LINKS.stateSites] });
  }

  if (a.sells !== "no") {
    steps.push({ id: "tax-ids", title: "Check state tax registration, including sales tax", why: "Selling goods and some services can require registering with your state before you collect tax.", links: [LINKS.taxIds] });
  }

  steps.push({ id: "bank", title: "Open a separate business bank account", why: "Keeping business and personal money apart makes bookkeeping and taxes much easier.", links: [LINKS.bank] });
  steps.push({ id: "estimated", title: "Plan for estimated tax payments", why: "Income that has no tax withheld is often paid in quarterly installments. Set aside money from each payment you receive.", links: [LINKS.estimated] });

  if (hasEmployees) {
    steps.push({ id: "employment-taxes", title: "Learn your employment tax duties", why: "Employers withhold and pay payroll taxes and file regular returns.", links: [LINKS.employmentTaxes] });
    steps.push({ id: "i9", title: "Complete Form I-9 for each new employee", why: "Employers must verify identity and work authorization for every person they hire.", links: [LINKS.i9] });
  }

  if (a.contractors === "yes") {
    steps.push({ id: "contractors", title: "Make sure contractors really are contractors", why: "How someone is classified depends on the working relationship, not on what you call it. Get a written agreement and check the rules.", links: [LINKS.contractor] });
  }

  steps.push({ id: "records", title: "Keep contracts, filings and key documents in one place", why: "You will need them for taxes, lenders, buyers and disputes. FounderOS has a Document Vault for this once you have access.", links: [] });

  return steps;
}
