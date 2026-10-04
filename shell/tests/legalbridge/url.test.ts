import { describe, expect, it } from "vitest";
import { legalReviewUrl } from "../../src/lib/legalbridge/bridge";

const ws = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rv = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("legalReviewUrl", () => {
  it("opens the workspace Contracts tab with the review", () => {
    expect(legalReviewUrl(ws, rv)).toBe(`/legal-ui/matters/${ws}/contracts?review=${rv}`);
    expect(legalReviewUrl(ws)).toBe(`/legal-ui/matters/${ws}/contracts`);
  });
  it("falls back to the LegalAI home for missing or malformed ids", () => {
    expect(legalReviewUrl(undefined, rv)).toBe("/legal-ui/");
    expect(legalReviewUrl("x/../y", rv)).toBe("/legal-ui/");
    expect(legalReviewUrl(ws, "nope")).toBe(`/legal-ui/matters/${ws}/contracts`);
  });
});
