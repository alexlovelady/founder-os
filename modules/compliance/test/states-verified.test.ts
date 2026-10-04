import { describe, expect, it } from "vitest";
import { STATE_PORTALS } from "../src/states";

const GOV_HOST = /(\.gov|\.us)$|^(www\.)?(sos\.state\.tx\.us|sec\.state\.ma\.us)$/;

describe("state portal verification", () => {
  it("verified entries use https URLs on government domains", () => {
    for (const s of STATE_PORTALS.filter((p) => p.verified)) {
      const u = new URL(s.url);
      expect(u.protocol, s.code).toBe("https:");
      expect(GOV_HOST.test(u.hostname), `${s.code} ${u.hostname}`).toBe(true);
    }
  });

  it("entries with a per-entry verification date are verified and well-formed", () => {
    for (const s of STATE_PORTALS.filter((p) => p.verifiedOn !== undefined)) {
      expect(s.verified, s.code).toBe(true);
      expect(s.verifiedOn, s.code).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("browser-verified states on 2026-10-04 are marked verified", () => {
    for (const code of ["AK", "IL", "MA", "MN", "MS", "NH", "NY", "OH"]) {
      const s = STATE_PORTALS.find((p) => p.code === code)!;
      expect(s.verified, code).toBe(true);
      expect(s.verifiedOn, code).toBe("2026-10-04");
    }
  });
});
