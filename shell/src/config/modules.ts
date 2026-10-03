/** The module registry. Adding a tool to FounderOS = one entry here plus its own folder under /modules. */
export type ModuleStatus = "live" | "planned";

export interface ModuleDef {
  id: string;
  name: string;
  tagline: string;
  route: string;
  status: ModuleStatus;
  /** Base URL of the module's own deployment (public env var so it can be changed without code). */
  baseUrl?: string;
}

export const MODULES: ModuleDef[] = [
  {
    id: "legal",
    name: "LegalAI",
    tagline: "Review contracts, draft documents, and ask legal questions with sources.",
    route: "/app/legal",
    status: "live",
    baseUrl: process.env.LEGAL_URL ?? "http://localhost:8000",
  },
  { id: "compliance", name: "Compliance", tagline: "Deadlines, filings and licenses for your business.", route: "/app/compliance", status: "planned" },
  { id: "finance", name: "Finance tools", tagline: "Runway, break-even, pricing and tax-reserve calculators.", route: "/app/finance", status: "planned" },
  { id: "health", name: "Business Health", tagline: "What you may be forgetting, by area.", route: "/app/health", status: "planned" },
];

export const getModule = (id: string) => MODULES.find((m) => m.id === id);
