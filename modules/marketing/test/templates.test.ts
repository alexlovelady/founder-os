import { describe, expect, it } from "vitest";
import { checkClaims } from "../src/guard";
import { KINDS, type ItemKind } from "../src/prompts";
import { renderTemplate, splitPoints, templateSources, toneFromBrand, TEMPLATE_TONES, type TemplateInput } from "../src/templates";

const full = (kind: ItemKind): TemplateInput => ({
  kind, businessName: "Acme Plumbing", offer: "free drain inspection", audience: "Charlotte homeowners", keyPoints: "Licensed plumbers\nFast scheduling\nClear written quotes",
  cta: "Call us to book", channel: "Instagram", location: "Charlotte", reviewText: "Great job on our kitchen sink", rating: "5", weeks: 2, senderName: "Pat",
});
const empty = (kind: ItemKind): TemplateInput => ({ kind });

describe("template drafts, table-driven by kind", () => {
  const cases: { kind: ItemKind; mustHave: RegExp[] }[] = [
    { kind: "social_post", mustHave: [/Option 1/, /Option 3/, /free drain inspection/, /Call us to book/] },
    { kind: "email", mustHave: [/^Subject: Free drain inspection/, /Preview:/, /- Licensed plumbers/, /Pat/, /Acme Plumbing/] },
    { kind: "landing_copy", mustHave: [/HEADLINE\nFree drain inspection/, /BENEFITS/, /HOW IT WORKS/, /\[●CUSTOMER QUOTE\]/, /Call us to book/] },
    { kind: "ad_copy", mustHave: [/Variant 3/, /Headline: /, /Description: /, /Call to action: Call us to book/] },
    { kind: "review_reply", mustHave: [/Replying to: "Great job on our kitchen sink"/, /Thank you for taking the time/, /Pat, Acme Plumbing/] },
    { kind: "blog_outline", mustHave: [/TITLE OPTIONS/, /## Licensed plumbers/, /## What to do next/, /\[●SOURCE NEEDED\]/] },
    { kind: "content_calendar", mustHave: [/Week 1/, /Week 2/, /Monday, Instagram, Licensed plumbers/] },
    { kind: "seo_ideas", mustHave: [/free drain inspection near Charlotte/, /PAGE OR BLOG IDEAS/, /LOCAL IDEAS/, /no search volumes/] },
  ];
  it("covers every kind", () => expect(cases.map((c) => c.kind).sort()).toEqual([...KINDS].sort()));
  for (const c of cases) {
    it(`${c.kind}: uses what was provided`, () => {
      const out = renderTemplate(full(c.kind));
      for (const re of c.mustHave) expect(out).toMatch(re);
      expect(out).not.toMatch(/\[●(OFFER|AUDIENCE|CALL TO ACTION|BUSINESS NAME)\]/);
    });
    it(`${c.kind}: leaves placeholders for everything missing and invents nothing`, () => {
      const out = renderTemplate(empty(c.kind));
      if (c.kind !== "content_calendar" && c.kind !== "review_reply") expect(out).toContain("[●OFFER]");
      expect(out).toMatch(/\[●[A-Z0-9 ,]+\]/);
      expect(out).not.toMatch(/undefined|null|NaN/);
      expect(checkClaims(out, [""])).toEqual([]);
    });
    it(`${c.kind}: is deterministic and passes the fabricated-claim guard against what the owner typed`, () => {
      const i = full(c.kind);
      expect(renderTemplate(i)).toBe(renderTemplate({ ...i }));
      expect(checkClaims(renderTemplate(i), [templateSources(i)])).toEqual([]);
    });
  }
});

describe("template details", () => {
  it("keeps ad headlines within 30 characters and descriptions within 90, and never cuts a placeholder in half", () => {
    const out = renderTemplate({ ...full("ad_copy"), offer: "an extremely long offer description that cannot possibly fit in thirty characters", keyPoints: "x".repeat(200) });
    for (const m of out.matchAll(/^Headline: (.*)$/gm)) expect(m[1].length).toBeLessThanOrEqual(m[1].startsWith("[●") ? 40 : 30);
    for (const m of out.matchAll(/^Description: (.*)$/gm)) expect(m[1].length).toBeLessThanOrEqual(90);
    expect(out).not.toMatch(/\[●[^\]]*$/m);
  });
  it("writes an apology for low ratings and a thank you for high ones", () => {
    expect(renderTemplate({ ...full("review_reply"), rating: "2" })).toMatch(/sorry your experience/);
    expect(renderTemplate({ ...full("review_reply"), rating: "5" })).not.toMatch(/sorry/);
    expect(renderTemplate({ kind: "review_reply" })).not.toMatch(/sorry/);
  });
  it("changes openers with the tone", () => {
    const by = Object.fromEntries(TEMPLATE_TONES.map((t) => [t, renderTemplate({ ...full("email"), tone: t })]));
    expect(by.formal).toContain("Dear Charlotte homeowners,");
    expect(by.playful).toContain("Hey there!");
    expect(by.warm).toContain("Warmly,");
    expect(by.neutral).toContain("Hello,");
    expect(new Set(Object.values(by)).size).toBe(TEMPLATE_TONES.length);
  });
  it("derives a tone from the brand sliders only when one is clearly strong", () => {
    expect(toneFromBrand({ formal: 50, playful: 50, bold: 50, warm: 50 })).toBe("neutral");
    expect(toneFromBrand({ formal: 20, playful: 80, bold: 40, warm: 70 })).toBe("playful");
  });
  it("splits key points on lines and semicolons and caps them", () => {
    expect(splitPoints("- one\n2. two; three\n\n")).toEqual(["one", "two", "three"]);
    expect(splitPoints(Array.from({ length: 20 }, (_, n) => `p${n}`).join("\n"))).toHaveLength(8);
  });
  it("clamps the calendar weeks", () => {
    expect((renderTemplate({ ...full("content_calendar"), weeks: 99 }).match(/^Week /gm) ?? []).length).toBe(12);
    expect((renderTemplate({ ...full("content_calendar"), weeks: 0 }).match(/^Week /gm) ?? []).length).toBe(1);
  });
});
