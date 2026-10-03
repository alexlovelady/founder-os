/**
 * Seed rules, versioned in code (global, not business data, so they do not live in the database).
 *
 * Rules of the road for this file:
 *  - Only add a rule you can point to an official source for. Record the date you loaded that URL in `lastVerified`.
 *  - Never state a fee, a due date or a threshold we did not read at the source. Send the user to the source instead.
 *  - Where applicability depends on facts we do not hold, set `alwaysCautious` and word it "Review whether ...".
 * Bump `RULES_VERSION` and the rule's `version` when you change anything here.
 */
import { applicableRules, type Rule, type RuleMatch } from "./engine";
import { findState, STATE_PORTALS, VERIFIED_ON } from "./states";
import type { BusinessProfile } from "@founderos/sdk";

export const RULES_VERSION = "2026-10-03.1";
const V = VERIFIED_ON;

const US: Rule["conditions"][number] = { type: "country", in: ["US"] };
const FORMAL = ["llc", "corporation", "s_corp", "partnership"];
const HAS_EMPLOYEES: Rule["conditions"][number] = { type: "anyOf", of: [{ type: "flag", key: "hasEmployees" }, { type: "employees", min: 1 }] };
const NOT_IDEA: Rule["conditions"][number] = { type: "stage", notIn: ["idea"] };

const src = (title: string, url: string) => ({ title, url, lastVerified: V });

const FEDERAL: Rule[] = [
  {
    id: "fed-ein", version: 1, category: "entity filing", priority: "high", recurrence: null,
    title: "Employer Identification Number (EIN)",
    description: "The IRS says businesses generally need an EIN to hire employees, to operate a partnership or corporation, or to pay sales and excise taxes. Keep the IRS confirmation letter with your business records.",
    conditions: [US, { type: "anyOf", of: [{ type: "entity", in: FORMAL }, HAS_EMPLOYEES] }],
    recommendation: "Confirm your business has an EIN and keep the IRS confirmation letter on file.",
    cautious: "Review whether your business needs an EIN (the IRS lists hiring employees and operating as a partnership or corporation among the reasons).",
    source: src("IRS: Get an employer identification number", "https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number"),
  },
  {
    id: "fed-income-tax-return", version: 1, category: "income tax", priority: "normal", recurrence: "yearly", alwaysCautious: true,
    title: "Federal income tax return for your business structure",
    description: "The IRS says your form of business determines which income tax return you file. Set the due date that applies to you once you have confirmed it with the IRS or your tax professional.",
    conditions: [US, NOT_IDEA],
    recommendation: "Review which federal income tax return your business structure files each year, and when it is due.",
    source: src("IRS: Business structures", "https://www.irs.gov/businesses/small-businesses-self-employed/business-structures"),
  },
  {
    id: "fed-estimated-tax", version: 1, category: "income tax", priority: "normal", recurrence: "quarterly", alwaysCautious: true,
    title: "Estimated tax payments",
    description: "The IRS describes estimated taxes as paid quarterly by those who expect to owe tax above set amounts when their return is filed. The IRS page points to Form 1040-ES and Publication 505 for the payment dates.",
    conditions: [US, { type: "stage", in: ["pre_revenue", "operating", "growing"] }],
    recommendation: "Review whether you need to make quarterly estimated tax payments, and note the due dates from the IRS.",
    source: src("IRS: Estimated taxes", "https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes"),
  },
  {
    id: "fed-s-corp-election", version: 1, category: "entity filing", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "S corporation election on file",
    description: "If your business is taxed as an S corporation, keep a copy of the election (Form 2553) and the IRS acceptance with your records.",
    conditions: [US, { type: "entity", in: ["s_corp"] }],
    recommendation: "Review that you have a copy of your S corporation election (Form 2553) and the IRS acceptance on file.",
    source: src("IRS: About Form 2553, Election by a Small Business Corporation", "https://www.irs.gov/forms-pubs/about-form-2553"),
  },
  {
    id: "fed-employment-taxes", version: 1, category: "payroll", priority: "high", recurrence: "quarterly",
    title: "Federal payroll taxes: withholding, deposits and reporting",
    description: "The IRS lists federal income tax withholding, Social Security and Medicare (FICA) and federal unemployment (FUTA) tax among the employment taxes employers handle, with forms such as 941 and W-2. Due dates are on the IRS pages.",
    conditions: [US, HAS_EMPLOYEES],
    recommendation: "Make sure payroll tax withholding, deposits and reports are set up and on schedule. See the IRS employment taxes page for forms and due dates.",
    cautious: "Review whether you must withhold, deposit and report federal employment taxes (see the IRS employment taxes page).",
    source: src("IRS: Employment taxes", "https://www.irs.gov/businesses/small-businesses-self-employed/employment-taxes"),
  },
  {
    id: "fed-form-w4", version: 1, category: "payroll", priority: "normal", recurrence: null,
    title: "Form W-4 from each new employee",
    description: "The IRS says to ask all new employees for a signed Form W-4 when they start work, to work out how much income tax to withhold.",
    conditions: [US, HAS_EMPLOYEES],
    recommendation: "Check that every employee has a signed Form W-4 on file.",
    cautious: "Review whether you need a signed Form W-4 from your workers.",
    source: src("IRS: Hiring employees", "https://www.irs.gov/businesses/small-businesses-self-employed/hiring-employees"),
  },
  {
    id: "fed-form-i9", version: 1, category: "payroll", priority: "high", recurrence: null,
    title: "Form I-9 for every employee",
    description: "USCIS says U.S. employers must complete Form I-9 for every individual they hire, and keep it for three years after hire or one year after the job ends, whichever is later, and make it available for inspection.",
    conditions: [US, HAS_EMPLOYEES],
    recommendation: "Check that a completed Form I-9 is on file for every employee and that you know how long to keep it.",
    cautious: "Review whether Form I-9 applies to the people you employ.",
    source: { title: "USCIS: Form I-9, Employment Eligibility Verification", url: "https://www.uscis.gov/i-9", lastVerified: V },
  },
  {
    id: "fed-state-employer-taxes", version: 1, category: "payroll", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "State employer registrations and taxes",
    description: "The SBA says that with employees you are responsible for state employment taxes, which vary by state and often include workers' compensation insurance, unemployment insurance taxes, and temporary disability insurance.",
    conditions: [US, HAS_EMPLOYEES],
    recommendation: "Review which state employer registrations, taxes and insurance apply to you as an employer, using your state's agencies.",
    source: src("SBA: Manage your business (hire and manage employees)", "https://www.sba.gov/counseling/manage-your-business/#hire-and-manage"),
  },
  {
    id: "fed-1099-nec", version: 1, category: "contractor documentation", priority: "normal", recurrence: "yearly", alwaysCautious: true,
    title: "Form 1099-NEC reporting for contractor payments",
    description: "Form 1099-NEC is the IRS form used to report payments to non-employees. Whether you must file depends on what you paid each person; check the IRS page and instructions for thresholds and due dates.",
    conditions: [US, { type: "flag", key: "usesContractors" }],
    recommendation: "Review whether Form 1099-NEC filing applies to what you paid your contractors this year.",
    source: src("IRS: About Form 1099-NEC, Nonemployee Compensation", "https://www.irs.gov/forms-pubs/about-form-1099-nec"),
  },
  {
    id: "fed-worker-classification", version: 1, category: "contractor documentation", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Worker classification: contractor or employee",
    description: "The IRS says correct classification depends on behavioral control, financial control and the type of relationship, and recommends documenting the factors behind each determination. Unsure cases can go to the IRS (Form SS-8).",
    conditions: [US, { type: "flag", key: "usesContractors" }],
    recommendation: "Review whether each person you treat as a contractor is correctly classified, and keep a written note of why.",
    source: src("IRS: Independent contractor (self-employed) or employee?", "https://www.irs.gov/businesses/small-businesses-self-employed/independent-contractor-self-employed-or-employee"),
  },
  {
    id: "fed-boi-status", version: 1, category: "entity filing", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Beneficial ownership information (BOI) reporting: check current status",
    description: `FinCEN's BOI page (loaded ${V}) says domestic U.S. companies are exempt from BOI reporting. This area has changed more than once, so confirm the current rules at FinCEN, especially if your company was formed outside the U.S. or registered to do business here.`,
    conditions: [US, { type: "entity", in: FORMAL }],
    recommendation: "Review FinCEN's current beneficial ownership reporting status for your company type.",
    source: src("FinCEN: Beneficial ownership information", "https://www.fincen.gov/boi"),
  },
  {
    id: "fed-licenses-permits", version: 1, category: "licenses", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Business licenses and permits",
    description: "The SBA says license and permit requirements and fees vary with your business activities, location and government rules; federal agencies regulate some activities and states often regulate others. Some permits expire and need renewal.",
    conditions: [US, NOT_IDEA],
    recommendation: "Review whether your business needs federal, state or local licenses or permits, and when each renews.",
    source: src("SBA: Apply for licenses and permits", "https://www.sba.gov/counseling/launch-your-business/#licenses-permits"),
  },
  {
    id: "fed-registered-agent", version: 1, category: "registered agent", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Registered agent",
    description: "The SBA says that for LLCs, corporations, partnerships or nonprofits a registered agent receives official papers and legal documents for your company, and must be located in the state where you registered.",
    conditions: [US, { type: "entity", in: ["llc", "corporation", "s_corp", "partnership"] }],
    recommendation: "Review that your registered agent is current and that the address on file with your state is right.",
    source: src("SBA: Register your business (registered agent)", "https://www.sba.gov/counseling/launch-your-business/#register-business"),
  },
  {
    id: "fed-trade-name", version: 1, category: "licenses", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Business name registration (DBA or trade name)",
    description: "The SBA describes entity names, trademarks, DBAs or trade names (which may be legally required), and domain names as separate registrations that are not necessarily identical.",
    conditions: [US, { type: "entity", in: ["sole_proprietor", "partnership"] }],
    recommendation: "Review whether you need to register a DBA or trade name if you do business under a name other than your own legal name.",
    source: src("SBA: Register your business (business names)", "https://www.sba.gov/counseling/launch-your-business/#register-business"),
  },
  {
    id: "fed-insurance", version: 1, category: "insurance", priority: "normal", recurrence: "yearly", alwaysCautious: true,
    title: "Business insurance",
    description: "Insurance needs depend on your business, location and contracts. The SBA has an overview of business insurance types. Note renewal dates here once you have policies.",
    conditions: [US, NOT_IDEA],
    recommendation: "Review what business insurance you may need, and the renewal date of any policies you hold.",
    source: src("SBA: Get business insurance", "https://www.sba.gov/counseling/launch-your-business/#business-insurance"),
  },
  {
    id: "fed-sales-tax", version: 1, category: "sales tax", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Sales tax collection and registration",
    description: "Sales tax rules differ by state and by what you sell. The Streamlined Sales Tax Governing Board describes registration and tax calculation help for sellers in its member states. Your state revenue agency is the final word.",
    conditions: [US, { type: "anyOf", of: [{ type: "flag", key: "hasCustomers" }, { type: "flag", key: "sellsAcrossStates" }, { type: "flag", key: "takesOnlinePayments" }] }],
    recommendation: "Review whether sales tax registration and collection applies in your state, and in any state where you sell.",
    source: src("Streamlined Sales Tax Governing Board", "https://www.streamlinedsalestax.org/"),
  },
  {
    id: "fed-multistate-sales-tax", version: 1, category: "sales tax", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Sales tax when you sell across state lines",
    description: "If you sell to customers in other states, your sales tax obligations can reach beyond your home state. The Streamlined Sales Tax Governing Board is one source for registration help in its member states; non-member states have their own rules.",
    conditions: [US, { type: "flag", key: "sellsAcrossStates" }],
    recommendation: "Review in which states you may need to register for sales tax based on where your customers are.",
    source: src("Streamlined Sales Tax Governing Board", "https://www.streamlinedsalestax.org/"),
  },
  {
    id: "fed-privacy", version: 1, category: "website privacy", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Privacy practices for customer data",
    description: "The FTC publishes business guidance on privacy and security. Privacy rules depend on what data you collect, from whom, and where they live. Keep a privacy policy that matches what you actually do.",
    conditions: [{ type: "anyOf", of: [{ type: "flag", key: "collectsPersonalData" }, { type: "flag", key: "hasWebsite" }] }],
    recommendation: "Review whether you need a privacy policy and whether it matches how you collect and use customer data.",
    source: src("FTC: Privacy and security guidance for business", "https://www.ftc.gov/business-guidance/privacy-security"),
  },
  {
    id: "fed-cybersecurity", version: 1, category: "security", priority: "normal", recurrence: "yearly", alwaysCautious: true,
    title: "Basic cybersecurity practices",
    description: "The FTC and CISA publish cybersecurity guidance for small businesses. This is good practice for any business that holds customer data or takes payments online, not a statement of a specific legal duty.",
    conditions: [{ type: "anyOf", of: [{ type: "flag", key: "collectsPersonalData" }, { type: "flag", key: "hasWebsite" }, { type: "flag", key: "takesOnlinePayments" }] }],
    recommendation: "Review your basic security (passwords and two-step sign-in, updates, backups) using the FTC and CISA small business guidance.",
    source: src("FTC: Cybersecurity for small business", "https://www.ftc.gov/business-guidance/small-businesses/cybersecurity"),
  },
  {
    id: "fed-pci", version: 1, category: "security", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Payment card security requirements",
    description: "Card payment security standards are set by the PCI Security Standards Council and enforced through your payment processor and card brands. Many small businesses meet them largely through their processor. Check what yours asks of you.",
    conditions: [{ type: "flag", key: "takesOnlinePayments" }],
    recommendation: "Review what card data security requirements your payment processor expects of you.",
    source: src("PCI Security Standards Council", "https://www.pcisecuritystandards.org/"),
  },
  {
    id: "fed-industry-licensing", version: 1, category: "industry-specific", priority: "normal", recurrence: null, alwaysCautious: true,
    title: "Industry-specific licensing and regulation",
    description: "The SBA notes that federal agencies regulate some activities and states often regulate others (for example construction, restaurants, retail and plumbing). Check the rules for your specific industry and location.",
    conditions: [US, { type: "industryKnown" }],
    recommendation: "Review whether your industry has its own licensing, inspection or regulatory requirements where you operate.",
    source: src("SBA: Apply for licenses and permits", "https://www.sba.gov/counseling/launch-your-business/#licenses-permits"),
  },
];

/** Per-state generic items. We link the state's official portal and say nothing about fees, frequencies or due dates. */
function stateRules(): Rule[] {
  const out: Rule[] = [];
  for (const s of STATE_PORTALS) {
    const source = { title: `${s.office} (official business filing portal)`, url: s.url, lastVerified: s.verified ? VERIFIED_ON : null };
    const check = s.verified ? "" : " We could not load this page automatically when we last checked, so confirm the address at source.";
    const base = { version: 1, priority: "normal" as const, source, alwaysCautious: true };
    out.push(
      {
        ...base, id: `state-${s.code.toLowerCase()}-registration`, category: "entity filing", recurrence: null,
        title: `${s.name}: business registration with the state`,
        description: `Formation and registration records for businesses in ${s.name} are handled through ${s.office}. Verify at source that your business is in good standing and the information on file is current.${check}`,
        conditions: [{ type: "state", is: s.code }, { type: "entity", in: [...FORMAL] }],
        recommendation: `Review that your business is registered and in good standing with ${s.office}.`,
      },
      {
        ...base, id: `state-${s.code.toLowerCase()}-periodic-report`, category: "annual reports", recurrence: null,
        title: `${s.name}: annual or periodic report`,
        description: `Many states require businesses to file an annual or periodic report to stay in good standing. Whether ${s.name} does for your entity type, how often and at what cost is set by the state. Verify at source, then set your own due date here.${check}`,
        conditions: [{ type: "state", is: s.code }, { type: "entity", in: [...FORMAL] }],
        recommendation: `Review whether ${s.name} requires an annual or periodic report for your business, and when it is due.`,
      },
    );
  }
  return out;
}

export const RULES: Rule[] = [...FEDERAL, ...stateRules()];

export const resolveStateCode = (s: string) => findState(s)?.code ?? null;

/** Rules that apply to this business right now, with cautious wording where we cannot be sure. */
export function rulesForBusiness(p: BusinessProfile, rules: Rule[] = RULES): RuleMatch[] {
  return applicableRules(rules, p, resolveStateCode);
}
