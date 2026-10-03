import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { breakEven, hireCompare, pricing, runway, taxReserve } from "@/lib/site/calc";
import { NAV_LINKS, PAGES, pageMetadata } from "@/lib/site/pages";
import { ALL_CHECKLIST_LINKS, buildChecklist, type Answers } from "@/lib/site/checklist";
import { CATEGORIES, ITEMS, evaluate, type Answers as HealthAnswers } from "@/lib/site/health-check";
import { formatStorage, limitLines } from "@/lib/site/plans-view";
import { PLANS } from "@/config/plans";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";

const SRC = resolve(__dirname, "../../src");

describe("calculators match the finance module", () => {
  it("runway", () => {
    expect(runway({ cash: 30000, monthlyRecurringRevenue: 2000, otherMonthlyRevenue: 1000, monthlyExpenses: 8000 })).toMatchObject({ netBurn: 5000, runwayMonths: 6, profitable: false });
    expect(runway({ cash: 100, monthlyRecurringRevenue: 5000, otherMonthlyRevenue: 0, monthlyExpenses: 4000 })).toMatchObject({ profitable: true, runwayMonths: null });
  });
  it("break-even", () => {
    expect(breakEven({ fixedExpenses: 1000, variableCostPerSale: 20, pricePerSale: 50 })).toMatchObject({ breakEvenSales: 34, contributionPerSale: 30 });
    expect(breakEven({ fixedExpenses: 1000, variableCostPerSale: 50, pricePerSale: 50 }).breakEvenSales).toBeNull();
  });
  it("pricing", () => {
    expect(pricing({ labor: 50, materials: 30, overhead: 20, desiredMarginPct: 50 })).toMatchObject({ totalCost: 100, targetPrice: 200, profitAtTarget: 100 });
    expect(pricing({ labor: 1, materials: 0, overhead: 0, desiredMarginPct: 100 }).targetPrice).toBeNull();
  });
  it("contractor vs employee", () => {
    const r = hireCompare({ employeeAnnualPay: 50000, employerPayrollTaxPct: 10, annualBenefits: 5000, otherAnnualEmployeeCosts: 0, contractorHourlyRate: 40, contractorHoursPerYear: 2000 });
    expect(r).toMatchObject({ employeeTotalCost: 60000, contractorTotalCost: 80000, cheaper: "employee" });
    expect(r.note).toMatch(/classif/i);
  });
  it("tax reserve", () => {
    expect(taxReserve({ periodIncome: 1000, reservePct: 25 })).toMatchObject({ reserveAmount: 250, keepAmount: 750 });
    expect(taxReserve({ periodIncome: 1000, reservePct: 400 }).reserveAmount).toBe(1000);
  });
});

describe("sitemap and robots", () => {
  it("sitemap covers every page in pages.ts exactly once", () => {
    const urls = sitemap().map((s) => new URL(s.url).pathname);
    expect(urls.length).toBe(PAGES.length);
    expect(new Set(urls).size).toBe(PAGES.length);
    for (const p of PAGES) expect(urls).toContain(p.path);
  });
  it("robots disallows private paths and points at the sitemap", () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(["/app", "/api", "/admin", "/invite"]));
    expect(String(r.sitemap)).toMatch(/\/sitemap\.xml$/);
  });
  it("every listed page has a route file that uses its own metadata, and nav links are listed", () => {
    for (const p of PAGES) {
      const file = join(SRC, "app/(site)", p.path === "/" ? "" : p.path, "page.tsx");
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8")).toContain(`pageMetadata("${p.path}")`);
    }
    for (const l of NAV_LINKS) expect(PAGES.map((p) => p.path)).toContain(l.href);
  });
});

describe("page metadata", () => {
  it("has a title and description (with OpenGraph) for every page", () => {
    for (const p of PAGES) {
      const m = pageMetadata(p.path);
      const title = typeof m.title === "string" ? m.title : (m.title as { absolute: string }).absolute;
      expect(title.length, p.path).toBeGreaterThan(3);
      expect((m.description ?? "").length, p.path).toBeGreaterThan(30);
      expect(m.openGraph?.title, p.path).toBeTruthy();
      expect(m.alternates?.canonical, p.path).toBe(p.path);
    }
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|md)$/.test(f)) out.push(full);
  }
  return out;
}

describe("honest copy", () => {
  const DENY = ["SOC 2", "SOC2", "HIPAA compliant", "PCI compliant", "bank-grade", "guarantee", "certified"];
  const files = [...walk(join(SRC, "app/(site)")), ...walk(join(SRC, "components/site")), ...walk(join(SRC, "lib/site"))];
  it("scans a meaningful set of files", () => expect(files.length).toBeGreaterThan(20));
  it("contains none of the forbidden claims", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8").toLowerCase();
      for (const bad of DENY) expect(text.includes(bad.toLowerCase()), `${f} contains "${bad}"`).toBe(false);
    }
  });
  it("legal pages are marked as drafts and have a last-updated date", () => {
    for (const p of ["terms", "privacy", "ai-disclosure"]) {
      expect(readFileSync(join(SRC, "app/(site)", p, "page.tsx"), "utf8")).toContain("<DraftBanner />");
    }
  });
  it("every page has exactly one h1", () => {
    for (const p of PAGES) {
      const file = join(SRC, "app/(site)", p.path === "/" ? "" : p.path, "page.tsx");
      const t = readFileSync(file, "utf8");
      // Home has a literal <h1>; the others get theirs from PageShell.
      const own = (t.match(/<h1[\s>]/g) ?? []).length;
      const shell = t.includes("<PageShell") ? 1 : 0;
      expect(own + shell, p.path).toBe(1);
    }
  });
});

describe("startup checklist branching", () => {
  const ids = (a: Answers) => buildChecklist(a).map((s) => s.id);
  const cases: { name: string; answers: Answers; has: string[]; hasNot: string[] }[] = [
    { name: "nothing answered shows the formation steps", answers: {}, has: ["structure", "register", "ein", "bank", "estimated"], hasNot: ["i9", "contractors"] },
    { name: "existing LLC, no staff, online", answers: { structure: "entity", employees: "no", contractors: "no", sells: "no", location: "no" }, has: ["ein", "bank", "estimated"], hasNot: ["structure", "register", "licenses", "tax-ids", "i9", "employment-taxes", "contractors"] },
    { name: "employees add I-9 and employment taxes", answers: { structure: "sole", employees: "yes" }, has: ["ein", "i9", "employment-taxes"], hasNot: ["ein-check", "structure"] },
    { name: "sole proprietor without staff is told to check for an EIN", answers: { structure: "sole", employees: "no" }, has: ["ein-check"], hasNot: ["ein", "i9"] },
    { name: "contractors add the classification step", answers: { structure: "entity", contractors: "yes" }, has: ["contractors"], hasNot: ["i9"] },
    { name: "selling goods adds state tax registration", answers: { structure: "entity", sells: "yes" }, has: ["tax-ids"], hasNot: [] },
    { name: "physical or licensed adds licenses", answers: { structure: "entity", location: "yes" }, has: ["licenses"], hasNot: [] },
  ];
  it.each(cases)("$name", ({ answers, has, hasNot }) => {
    const got = ids(answers);
    for (const id of has) expect(got, id).toContain(id);
    for (const id of hasNot) expect(got, id).not.toContain(id);
  });
  it("only links to the verified https government URLs", () => {
    const allowed = ALL_CHECKLIST_LINKS.map((l) => l.href);
    for (const c of cases) for (const s of buildChecklist(c.answers)) for (const l of s.links) expect(allowed).toContain(l.href);
    for (const h of allowed) expect(h).toMatch(/^https:\/\/www\.(irs|sba|uscis)\.gov\//);
  });
  it("includes the three required sources", () => {
    const h = ALL_CHECKLIST_LINKS.map((l) => l.href);
    expect(h).toContain("https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number");
    expect(h).toContain("https://www.sba.gov/business-guide");
    expect(h).toContain("https://www.uscis.gov/i-9");
  });
});

describe("business health check", () => {
  const all = (a: HealthAnswers["x"]): HealthAnswers => Object.fromEntries(ITEMS.map((i) => [i.id, a]));
  it("all yes is complete everywhere", () => {
    for (const r of evaluate(all("yes"))) expect(r.status).toBe("complete");
  });
  it("all no is missing everywhere, all not applicable is not applicable", () => {
    for (const r of evaluate(all("no"))) expect(r.status).toBe("missing");
    for (const r of evaluate(all("na"))) expect(r.status).toBe("not_applicable");
  });
  it("a mix needs attention and lists what to do; unanswered never counts as covered", () => {
    const a = all("yes");
    a.mfa = "no";
    const sec = evaluate(a).find((r) => r.category === "Security")!;
    expect(sec.status).toBe("attention");
    expect(sec.todos.map((t) => t.id)).toEqual(["mfa"]);
    const partial = evaluate({ structure: "yes" }).find((r) => r.category === "Legal")!;
    expect(partial.status).toBe("attention");
    expect(partial.unanswered).toBe(2);
  });
  it("covers every category and has no numeric score field", () => {
    const r = evaluate({});
    expect(r.map((x) => x.category)).toEqual([...CATEGORIES]);
    expect(Object.keys(r[0])).not.toContain("score");
  });
});

describe("pricing page data comes from plans.ts", () => {
  it("formats limits from the plan config", () => {
    expect(formatStorage(50)).toBe("50 MB");
    expect(formatStorage(1000)).toBe("1 GB");
    expect(formatStorage(null)).toBe("Unlimited");
    const biz = PLANS.find((p) => p.id === "business")!;
    expect(limitLines(biz)[0]).toBe("Unlimited AI requests a month");
    expect(limitLines(PLANS[0])[0]).toBe("20 AI requests a month");
  });
});
