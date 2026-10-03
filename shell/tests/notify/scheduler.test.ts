import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { disabledProvider } from "../../src/lib/notify/email";
import { JOBS, runDueJobs, startScheduler, type JobDef } from "../../src/lib/notify/scheduler";
import { NOW, scripted } from "./helpers";

let env: TestEnv;
const tools = [scripted([{ id: "finance-runway", title: "Cash is low", severity: "high" }], "One line.")];
beforeAll(async () => { env = await makeTestEnv(tools); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.sql`DELETE FROM scheduled_runs`; });

const runs = async (job: string) => env.sql<{ ok: boolean; detail: string }[]>`SELECT ok, detail FROM scheduled_runs WHERE job = ${job}`;
const deps = (now = NOW) => ({ now, tools, provider: disabledProvider });

describe("scheduler", () => {
  it("runs each due job once, records it, and does nothing on the next tick", async () => {
    const r = await runDueJobs(env.sql, deps());
    expect(r).toEqual({ locked: false, ran: ["outbox", "reminder_sweep", "weekly_brief"] });
    expect(await runDueJobs(env.sql, deps())).toEqual({ locked: false, ran: [] });
    for (const j of JOBS) expect(await runs(j.name)).toHaveLength(1);
    // The sweep and the brief did real work for this business.
    expect(await env.sql`SELECT 1 FROM notifications WHERE business_id = ${env.ctx.businessId} AND dedupe_key = 'reminder:finance-runway:none'`).toHaveLength(1);
    expect(await env.sql`SELECT 1 FROM weekly_briefs WHERE business_id = ${env.ctx.businessId} AND week_start = '2026-10-05'`).toHaveLength(1);
  });

  it("runs again when the period rolls over: outbox hourly, sweep daily, brief weekly", async () => {
    await runDueJobs(env.sql, deps());
    const in2h = new Date(NOW.getTime() + 2 * 3_600_000);
    expect((await runDueJobs(env.sql, deps(in2h))).ran).toEqual(["outbox"]);
    const tomorrow = new Date("2026-10-08T12:00:00Z");
    expect((await runDueJobs(env.sql, deps(tomorrow))).ran).toEqual(["outbox", "reminder_sweep"]);
    const nextMonday = new Date("2026-10-12T08:00:00Z");
    expect((await runDueJobs(env.sql, deps(nextMonday))).ran).toEqual(["outbox", "reminder_sweep", "weekly_brief"]);
    // Re-running never duplicates the data.
    expect(await env.sql`SELECT 1 FROM notifications WHERE business_id = ${env.ctx.businessId} AND dedupe_key LIKE 'reminder:%'`).toHaveLength(1);
  });

  it("only one instance runs the jobs: a concurrent tick is locked out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: JobDef = { name: "slow", due: () => true, run: async () => { await gate; return { ok: true, detail: "done" }; } };
    const a = runDueJobs(env.sql, deps(), [slow]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await runDueJobs(env.sql, deps(), [slow])).toEqual({ locked: true, ran: [] });
    release();
    expect(await a).toEqual({ locked: false, ran: ["slow"] });
    expect(await runs("slow")).toHaveLength(1);
  });

  it("two simultaneous ticks still run each job exactly once", async () => {
    await Promise.all([runDueJobs(env.sql, deps()), runDueJobs(env.sql, deps())]);
    for (const j of JOBS) expect(await runs(j.name)).toHaveLength(1);
  });

  it("a failing job is recorded, does not stop the others, and is retried only after a pause", async () => {
    const bad: JobDef = { name: "bad", due: () => true, run: async () => { throw new Error("boom"); } };
    const good: JobDef = { name: "good", due: () => true, run: async () => ({ ok: true, detail: "fine" }) };
    expect((await runDueJobs(env.sql, deps(), [bad, good])).ran).toEqual(["bad", "good"]);
    expect(await runs("bad")).toEqual([{ ok: false, detail: "error: boom" }]);
    expect((await runDueJobs(env.sql, deps(new Date(NOW.getTime() + 60_000)), [bad])).ran).toEqual([]);
    expect((await runDueJobs(env.sql, deps(new Date(NOW.getTime() + 31 * 60_000)), [bad])).ran).toEqual(["bad"]);
  });

  it("never starts during the production build or when disabled, and starts only once", () => {
    const keep = { ...process.env };
    process.env.DATABASE_URL = "postgres://unused";
    process.env.NEXT_PHASE = "phase-production-build";
    expect(startScheduler()).toBe(false);
    process.env.NEXT_PHASE = "";
    process.env.SCHEDULER_DISABLED = "1";
    expect(startScheduler()).toBe(false);
    process.env.SCHEDULER_DISABLED = "";
    process.env.SCHEDULER_TICK_MS = "3600000";
    expect(startScheduler()).toBe(true);
    expect(startScheduler()).toBe(false);
    clearInterval(globalThis.__founderosScheduler);
    globalThis.__founderosScheduler = undefined;
    process.env = keep;
  });
});
