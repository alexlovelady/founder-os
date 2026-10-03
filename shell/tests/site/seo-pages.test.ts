import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PAGES, pageMetadata } from "@/lib/site/pages";
import sitemap from "@/app/sitemap";
import { SOP_SECTIONS } from "../../../modules/sops/src/sop";

const SRC = resolve(__dirname, "../../src");
const ROOT = resolve(__dirname, "../../..");
const SEO = ["/contract-review", "/contractor-agreement", "/nda-generator", "/sop-generator"] as const;
const file = (p: string) => join(SRC, "app/(site)", p, "page.tsx");
const text = (p: string) => readFileSync(file(p), "utf8");
const FAQ_FILE = join(SRC, "app/(site)/contract-review/_faq.tsx");

describe("SEO pages are listed and indexed", () => {
  it("each is in pages.ts, has a route file and appears exactly once in the sitemap", () => {
    const urls = sitemap().map((s) => new URL(s.url).pathname);
    for (const p of SEO) {
      expect(PAGES.filter((x) => x.path === p), p).toHaveLength(1);
      expect(existsSync(file(p)), p).toBe(true);
      expect(urls.filter((u) => u === p), p).toHaveLength(1);
    }
  });
  it("each has a distinct title, a real description and OpenGraph with its own url", () => {
    const titles = new Set<string>();
    for (const p of SEO) {
      const m = pageMetadata(p);
      const title = typeof m.title === "string" ? m.title : (m.title as { absolute: string }).absolute;
      expect(title.length, p).toBeGreaterThan(15);
      titles.add(title);
      expect((m.description ?? "").length, p).toBeGreaterThan(80);
      expect((m.description ?? "").length, p).toBeLessThan(330);
      expect(m.alternates?.canonical, p).toBe(p);
      expect(m.openGraph?.title, p).toBe(title);
      expect(m.openGraph?.description, p).toBe(m.description);
      expect((m.openGraph as { url?: string }).url, p).toBe(p);
    }
    expect(titles.size).toBe(SEO.length);
  });
  it("each page file uses its own metadata and exactly one h1 through PageShell", () => {
    for (const p of SEO) {
      const t = text(p);
      expect(t, p).toContain(`pageMetadata("${p}")`);
      expect((t.match(/<PageShell\b/g) ?? []).length, p).toBe(1);
      expect((t.match(/<h1[\s>]/g) ?? []).length, p).toBe(0);
    }
  });
});

describe("SEO page structure", () => {
  it("every page has an FAQ with at least four answers, a sign-in call to action and the not-advice note", () => {
    for (const p of SEO) {
      const t = text(p);
      expect(t, p).toContain("<Faq items={FAQ}");
      expect((t.match(/^\s+q: "/gm) ?? []).length, p).toBeGreaterThanOrEqual(4);
      expect(t, p).toContain("<SignInCta");
      expect(t, p).toContain("<NotAdvice");
    }
  });
  it("the FAQ block writes matching FAQPage data and escapes it", () => {
    const t = readFileSync(FAQ_FILE, "utf8");
    expect(t).toContain('"@type": "FAQPage"');
    expect(t).toContain('replace(/</g, "\\\\u003c")');
    expect((t.match(/<h1[\s>]/g) ?? []).length).toBe(0);
  });
  it("internal links only point at pages that exist (or the sign-in page)", () => {
    const known = new Set([...PAGES.map((p) => p.path), "/login"]);
    for (const p of SEO) {
      const links = [...text(p).matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]);
      expect(links.length, p).toBeGreaterThanOrEqual(3);
      for (const l of links) expect(known.has(l), `${p} links to ${l}`).toBe(true);
    }
  });
  it("each links to at least one related free tool", () => {
    for (const p of SEO) expect(text(p), p).toMatch(/href="\/tools\//);
  });
  it("no generator form: nothing on these pages collects input", () => {
    for (const p of SEO) {
      const t = text(p);
      for (const tag of ["<form", "<input", "<textarea", "<select", "useState"]) expect(t.includes(tag), `${p} contains ${tag}`).toBe(false);
    }
  });
});

describe("SEO page honesty", () => {
  const DENY = [
    "SOC 2", "SOC2", "HIPAA", "ISO 27001", "PCI", "certified", "certification", "bank-grade", "guarantee", "guaranteed",
    "trusted by", "customers love", "testimonial", "5-star", "five-star", "rated", "award", "best-in-class", "#1", "100%",
    "lawyer-approved", "attorney-approved", "attorney-reviewed", "legally binding", "court-ready", "ready to sign", "compliant",
    "instantly", "no lawyer needed", "replaces your lawyer", "thousands of", "millions of",
  ];
  const files = [...SEO.map((p) => file(p)), FAQ_FILE];
  it("contains none of the forbidden claims", () => {
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      for (const bad of DENY) expect(new RegExp(`(^|[^a-z])${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(t), `${f} contains "${bad}"`).toBe(false);
    }
  });
  it("legal-document pages say they are not legal advice and that a lawyer should review", () => {
    for (const p of ["/contract-review", "/contractor-agreement", "/nda-generator"] as const) {
      const t = text(p);
      expect(t, p).toMatch(/not a law firm/i);
      expect(t, p).toMatch(/lawyer/i);
    }
    for (const p of ["/contractor-agreement", "/nda-generator"] as const) {
      expect(text(p), p).toMatch(/reviewed by a qualified lawyer|Have a lawyer review/);
      expect(text(p), p).toMatch(/no generator form on this page|not a form/);
    }
  });
  it("the contract review page says there is no public checker and that quotes are checked, not that the contract is safe", () => {
    const t = text("/contract-review");
    expect(t).toContain("There is no public contract checker");
    expect(t).toMatch(/word for word/);
    expect(t).toMatch(/not advice on whether to sign/);
    expect(t).not.toMatch(/safe to sign|this contract is (enforceable|legal)/i);
  });
  it("the SOP page says the builder works without AI", () => {
    expect(text("/sop-generator")).toMatch(/without AI/);
  });
  it("does not copy plan prices or limits (they come from plans.ts)", () => {
    for (const p of SEO) expect(text(p), p).not.toMatch(/\$\d/);
    for (const p of SEO) expect(text(p), p).not.toMatch(/\b\d+ AI requests/i);
  });
});

describe("SEO page content matches the code it describes", () => {
  it("the SOP page lists every section the SOP builder produces, in order", () => {
    expect(SOP_SECTIONS).toHaveLength(10);
    const t = text("/sop-generator");
    let at = -1;
    for (const s of SOP_SECTIONS) {
      const i = t.indexOf(`name: "${s}"`);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
  });

  const catalog = readFileSync(join(ROOT, "modules/legal/api/legalai/startup/catalog.py"), "utf8");
  const outlineOf = (id: string): string[] => {
    const start = catalog.indexOf(`"id": "${id}"`);
    const o = catalog.indexOf('"outline": [', start);
    const end = catalog.indexOf("],", o);
    return [...catalog.slice(o, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(1);
  };
  it.each([
    ["nda_mutual", "/nda-generator"],
    ["contractor_agreement", "/contractor-agreement"],
  ] as const)("the %s outline in the drafting catalog is what %s describes", (id, path) => {
    const outline = outlineOf(id);
    expect(outline.length).toBeGreaterThanOrEqual(9);
    const t = text(path);
    for (const heading of outline) {
      const base = heading.replace(/\s*\(.*\)\s*$/, "").trim();
      expect(t.includes(`name: "${base}"`), `${path} is missing "${base}"`).toBe(true);
    }
  });
});
