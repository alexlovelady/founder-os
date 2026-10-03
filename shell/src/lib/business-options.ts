// Plain constants and types, safe to import from client components (no database code here).
export const ENTITY_TYPES = [
  { id: "sole_proprietor", label: "Sole proprietor" },
  { id: "llc", label: "LLC" },
  { id: "partnership", label: "Partnership" },
  { id: "corporation", label: "Corporation (C-corp)" },
  { id: "s_corp", label: "S-corp" },
  { id: "not_formed", label: "Not formed yet" },
  { id: "not_sure", label: "Not sure" },
] as const;

export const STAGES = [
  { id: "idea", label: "Just an idea" },
  { id: "forming", label: "Forming the company" },
  { id: "pre_revenue", label: "Launched, no revenue yet" },
  { id: "operating", label: "Operating with customers" },
  { id: "growing", label: "Growing" },
] as const;

export const OPERATION_QUESTIONS = [
  { key: "hasEmployees", label: "We have employees" },
  { key: "usesContractors", label: "We use contractors or freelancers" },
  { key: "hasCustomers", label: "We have paying customers" },
  { key: "takesOnlinePayments", label: "We take online payments" },
  { key: "recurringBilling", label: "We bill customers on a subscription" },
  { key: "collectsPersonalData", label: "We collect customers' personal data" },
  { key: "hasWebsite", label: "We have a website or app" },
  { key: "sellsAcrossStates", label: "We sell across state lines" },
] as const;

export const GOALS = [
  "Start my business",
  "Stay compliant",
  "Review contracts",
  "Organize documents",
  "Improve finances",
  "Find customers",
  "Build processes",
  "Prepare to hire",
] as const;

export interface Business {
  id: string;
  name: string;
  description: string;
  industry: string;
  entityType: string;
  country: string;
  state: string;
  city: string;
  website: string;
  lifecycleStage: string;
  employeeCount: number | null;
  operations: Record<string, boolean>;
  goals: string[];
  role: string;
  modules: Record<string, unknown>;
  createdAt: string;
}
