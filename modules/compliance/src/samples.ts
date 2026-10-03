/**
 * Built-in sample businesses for the admin "which businesses would this rule apply to" preview. They are invented profiles, not data
 * from any real business. Together they cover formed and unformed entities, employees or none, contractors, missing answers (to
 * show the cautious wording) and a non-US location.
 */
import type { BusinessProfile } from "@founderos/sdk";
import { matchRule, type Rule } from "./engine";
import { resolveStateCode } from "./seed";

const base: BusinessProfile = {
  id: "sample", name: "", description: "", industry: "", entityType: "llc", country: "United States", state: "North Carolina", city: "", website: "",
  lifecycleStage: "operating", employeeCount: 0, operations: {}, goals: [],
};

export interface SampleProfile { key: string; label: string; profile: BusinessProfile }

export const SAMPLE_PROFILES: SampleProfile[] = [
  {
    key: "nc-llc-employees", label: "North Carolina LLC with 4 employees (home services)",
    profile: { ...base, id: "s1", name: "Sample A", industry: "Home services", employeeCount: 4, operations: { hasEmployees: true, usesContractors: false, hasCustomers: true, hasWebsite: true, collectsPersonalData: true, takesOnlinePayments: false, sellsAcrossStates: false } },
  },
  {
    key: "tx-solo-contractors", label: "Texas sole proprietor using contractors (design)",
    profile: { ...base, id: "s2", name: "Sample B", industry: "Graphic design", entityType: "sole_proprietor", state: "Texas", employeeCount: 0, operations: { hasEmployees: false, usesContractors: true, hasCustomers: true, hasWebsite: true, collectsPersonalData: false, takesOnlinePayments: true, sellsAcrossStates: true } },
  },
  {
    key: "ca-corp-restaurant", label: "California S corporation, restaurant, 12 employees",
    profile: { ...base, id: "s3", name: "Sample C", industry: "Restaurant and food service", entityType: "s_corp", state: "California", employeeCount: 12, lifecycleStage: "growing", operations: { hasEmployees: true, usesContractors: false, hasCustomers: true, hasWebsite: true, collectsPersonalData: true, takesOnlinePayments: true, sellsAcrossStates: false } },
  },
  {
    key: "ny-idea-stage", label: "New York idea-stage founder, not formed",
    profile: { ...base, id: "s4", name: "Sample D", industry: "Software", entityType: "not_formed", state: "New York", lifecycleStage: "idea", employeeCount: null, operations: {} },
  },
  {
    key: "fl-unknown-answers", label: "Florida LLC, onboarding answers missing",
    profile: { ...base, id: "s5", name: "Sample E", industry: "", entityType: "llc", state: "Florida", employeeCount: null, operations: {} },
  },
  {
    key: "ca-canada", label: "Canadian company (outside the US)",
    profile: { ...base, id: "s6", name: "Sample F", industry: "Consulting", entityType: "corporation", country: "Canada", state: "Ontario", employeeCount: 3, operations: { hasEmployees: true, usesContractors: false, hasCustomers: true, hasWebsite: true } },
  },
];

export interface PreviewRow { key: string; label: string; applies: boolean; certainty: "certain" | "uncertain" | null; wording: string | null }

/** Evaluate a rule against every sample profile with the real engine. */
export function previewRule(rule: Rule): PreviewRow[] {
  return SAMPLE_PROFILES.map((s) => {
    const m = matchRule(rule, s.profile, resolveStateCode);
    return { key: s.key, label: s.label, applies: m !== null, certainty: m?.certainty ?? null, wording: m?.recommendation ?? null };
  });
}
