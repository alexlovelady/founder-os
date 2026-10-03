/**
 * Subscription plans. This is the ONLY place plan names, prices, limits and feature flags live; pages, billing and the tools read from it.
 * Prices are placeholders chosen inside the ranges in the product spec and are expected to change: edit them here, then set the matching
 * Stripe price ids in the environment (see docs/BILLING.md). A limit of null means unlimited.
 */
import type { PlanInfo } from "@founderos/sdk";

export type PlanId = "free" | "founder" | "pro" | "business";

export interface PlanDef extends PlanInfo {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in US dollars; 0 for free. Display only: Stripe is the source of truth for what is charged. */
  priceMonthlyUsd: number;
  /** Which AI the plan uses. Only "local" (the owner's private GPU) is built; the others are reserved for later plans. */
  aiTier: "local" | "cloud" | "bring_your_own";
  highlights: string[];
}

export const PLANS: PlanDef[] = [
  {
    id: "free",
    name: "Free",
    tagline: "Get organized and try the tools.",
    priceMonthlyUsd: 0,
    aiTier: "local",
    limits: { aiRequestsPerMonth: 20, storageMb: 50, teamMembers: 1, competitors: 2, productRepos: 1 },
    features: { competitorResearch: true, productScan: true, weeklyBrief: false, teamInvites: false, dataExport: true },
    highlights: ["Business profile and checklist", "Calculators", "20 AI requests a month", "50 MB of documents"],
  },
  {
    id: "founder",
    name: "Founder",
    tagline: "Everything a solo founder needs.",
    priceMonthlyUsd: 24,
    aiTier: "local",
    limits: { aiRequestsPerMonth: 300, storageMb: 1000, teamMembers: 2, competitors: 5, productRepos: 3 },
    features: { competitorResearch: true, productScan: true, weeklyBrief: true, teamInvites: true, dataExport: true },
    highlights: ["All tools", "300 AI requests a month", "1 GB of documents", "Weekly business brief"],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For growing teams.",
    priceMonthlyUsd: 59,
    aiTier: "local",
    limits: { aiRequestsPerMonth: 1500, storageMb: 10000, teamMembers: 10, competitors: 20, productRepos: 10 },
    features: { competitorResearch: true, productScan: true, weeklyBrief: true, teamInvites: true, dataExport: true },
    highlights: ["Higher limits", "Up to 10 team members", "10 GB of documents"],
  },
  {
    id: "business",
    name: "Business",
    tagline: "Larger teams and priority support.",
    priceMonthlyUsd: 149,
    aiTier: "local",
    limits: { aiRequestsPerMonth: null, storageMb: 100000, teamMembers: 50, competitors: null, productRepos: null },
    features: { competitorResearch: true, productScan: true, weeklyBrief: true, teamInvites: true, dataExport: true },
    highlights: ["Unlimited AI requests", "100 GB of documents", "Up to 50 team members"],
  },
];

export const DEFAULT_PLAN: PlanId = "free";
export const getPlan = (id: string | null | undefined): PlanDef => PLANS.find((p) => p.id === id) ?? PLANS[0];
