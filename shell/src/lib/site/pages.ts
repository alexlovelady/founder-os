/**
 * The single list of public pages. The sitemap, the header/footer links and every page's metadata are all derived from it,
 * so a page that is not listed here does not appear in the sitemap. Add the route file under src/app/(site)/ and an entry here.
 */
import type { Metadata } from "next";

export type PageGroup = "main" | "tools" | "legal";

export interface SitePage {
  path: string;
  title: string;
  description: string;
  group: PageGroup;
  priority: number;
  changeFrequency: "weekly" | "monthly" | "yearly";
}

export const PAGES: SitePage[] = [
  { path: "/", title: "FounderOS: your back office for starting and running a business", description: "Contracts, documents, compliance, tasks, customers and money in one place, with tools that share what they know about your business.", group: "main", priority: 1, changeFrequency: "monthly" },
  { path: "/features", title: "Features", description: "LegalAI, Compliance Center, Business Health, Document Vault, Tasks, CRM, SOPs, Marketing, Finance tools and a read-only assistant, working from one business profile.", group: "main", priority: 0.8, changeFrequency: "monthly" },
  { path: "/pricing", title: "Pricing", description: "Plans for solo founders through larger teams. Checkout is not live yet; accounts are created by invitation for now.", group: "main", priority: 0.8, changeFrequency: "monthly" },
  { path: "/legal-ai", title: "LegalAI: contract review, drafting and cited research", description: "AI-assisted contract review, drafting and research with citations to the source text. A software tool that supports your own review, not a law firm.", group: "main", priority: 0.7, changeFrequency: "monthly" },
  { path: "/business-health", title: "Business Health", description: "See what your business has covered, what needs attention and what is missing, category by category, with no made-up score.", group: "main", priority: 0.7, changeFrequency: "monthly" },
  { path: "/security", title: "Security", description: "What FounderOS actually does to protect your data today, and what is not done yet. No certifications are claimed.", group: "main", priority: 0.6, changeFrequency: "monthly" },
  { path: "/contact", title: "Contact", description: "Access to FounderOS is by invitation for now. How to get in touch.", group: "main", priority: 0.4, changeFrequency: "yearly" },
  { path: "/tools", title: "Free business tools", description: "Free calculators, a startup checklist and a business health check. They run in your browser and send nothing anywhere.", group: "tools", priority: 0.8, changeFrequency: "monthly" },
  { path: "/tools/runway-calculator", title: "Runway calculator", description: "Work out your monthly burn and how many months of cash you have left. Runs in your browser; nothing is sent anywhere.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/tools/break-even-calculator", title: "Break-even calculator", description: "Find how many sales you need each month to cover your fixed costs. Runs in your browser; nothing is sent anywhere.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/tools/pricing-calculator", title: "Pricing calculator", description: "Turn your costs and a target margin into a price. Runs in your browser; nothing is sent anywhere.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/tools/contractor-vs-employee", title: "Contractor vs employee cost calculator", description: "Compare the yearly cost of an employee and a contractor. Cost only: it does not decide how someone must be classified.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/tools/tax-reserve", title: "Tax reserve calculator", description: "Estimate how much of your income to set aside using a percentage you choose. Not a tax calculation.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/tools/startup-checklist", title: "Startup checklist", description: "Answer a few questions and get a list of generic startup steps with links to official government sources.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/tools/business-health-check", title: "Business health check", description: "A short questionnaire that shows which areas look covered, which need attention and which are missing. No score.", group: "tools", priority: 0.7, changeFrequency: "yearly" },
  { path: "/terms", title: "Terms of Service (draft)", description: "Draft terms for using FounderOS, in plain English. Pending professional legal review.", group: "legal", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", title: "Privacy Policy (draft)", description: "Draft description of what data FounderOS collects, where it is processed and how it is used. Pending professional legal review.", group: "legal", priority: 0.3, changeFrequency: "yearly" },
  { path: "/ai-disclosure", title: "AI disclosure (draft)", description: "How AI is used in FounderOS, where it runs, what it can get wrong and what we do not do with your data. Pending professional legal review.", group: "legal", priority: 0.3, changeFrequency: "yearly" },
];

export const pageByPath = (path: string): SitePage => {
  const p = PAGES.find((x) => x.path === path);
  if (!p) throw new Error(`Page ${path} is not listed in src/lib/site/pages.ts`);
  return p;
};

/** Metadata for a listed page. Use as `export const metadata = pageMetadata("/features")`. */
export function pageMetadata(path: string): Metadata {
  const p = pageByPath(path);
  return {
    title: path === "/" ? { absolute: p.title } : p.title,
    description: p.description,
    alternates: { canonical: path },
    openGraph: { title: p.title, description: p.description, url: path, siteName: "FounderOS", type: "website" },
    twitter: { card: "summary", title: p.title, description: p.description },
  };
}

export const NAV_LINKS = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/tools", label: "Tools" },
  { href: "/security", label: "Security" },
] as const;

export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms (draft)" },
  { href: "/privacy", label: "Privacy (draft)" },
  { href: "/ai-disclosure", label: "AI disclosure (draft)" },
] as const;
