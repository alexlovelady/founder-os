import { describe, expect, it } from "vitest";
import { planAiRows, probeLegal } from "@/lib/admin/ai";

const fake = (impl: () => Promise<Response>) => (async () => impl()) as unknown as typeof fetch;

describe("probeLegal", () => {
  it("reports healthy", async () => {
    const r = await probeLegal("http://legal/", fake(async () => Response.json({ ok: true })));
    expect(r).toMatchObject({ reachable: true, detail: "Healthy" });
  });
  it("reports an error status, a bad body, and a network failure without throwing", async () => {
    expect(await probeLegal("http://legal", fake(async () => new Response("no", { status: 503 })))).toMatchObject({ reachable: false, detail: "Responded with HTTP 503" });
    expect(await probeLegal("http://legal", fake(async () => Response.json({ ok: false })))).toMatchObject({ reachable: false });
    expect(await probeLegal("http://legal", fake(async () => { throw new Error("down"); }))).toEqual({ reachable: false, detail: "Not reachable", ms: null });
  });
});

describe("planAiRows", () => {
  it("lists every plan with its tier; only local exists", () => {
    const rows = planAiRows();
    expect(rows.map((r) => r.plan)).toEqual(["free", "founder", "pro", "business"]);
    expect(new Set(rows.map((r) => r.aiTier))).toEqual(new Set(["local"]));
    expect(rows.find((r) => r.plan === "business")?.aiRequestsPerMonth).toBeNull();
  });
});
