import { PLANS, type PlanDef } from "@/config/plans";

export const formatPrice = (p: PlanDef): string => (p.priceMonthlyUsd === 0 ? "Free" : `$${p.priceMonthlyUsd}/month`);

export const formatStorage = (mb: number | null | undefined): string => {
  if (mb == null) return "Unlimited";
  return mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
};

const count = (n: number | null | undefined, unit: string): string => (n == null ? `Unlimited ${unit}` : `${n.toLocaleString("en-US")} ${unit}`);

/** Limit lines for a plan card, read from plans.ts so the page never disagrees with the app. */
export function limitLines(p: PlanDef): string[] {
  const l = p.limits;
  return [
    `${count(l.aiRequestsPerMonth, "AI requests a month")}`,
    `${formatStorage(l.storageMb)} of documents`,
    `${count(l.teamMembers, l.teamMembers === 1 ? "team member" : "team members")}`,
    `${count(l.competitors, "tracked competitors")}`,
    `${count(l.productRepos, l.productRepos === 1 ? "product repository" : "product repositories")}`,
  ];
}

export const allPlans = (): PlanDef[] => PLANS;
