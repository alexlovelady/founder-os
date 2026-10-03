import { describe, expect, it } from "vitest";
import {
  askErrorMessage, collapse, COMMANDS, dayNumber, describeDue, docsView, filterCommands, financeView, formatMoney, formatMonth, formatRunway, gettingStarted,
  greeting, healthSummary, isCommandQuery, moveIndex, readSnapshot, selectUpcoming, sortBySeverity, tasksView, todayKey, type AttentionLike,
} from "@/lib/dashboard/logic";

const item = (id: string, dueDate: string | undefined, severity: AttentionLike["severity"] = "review", title = id): AttentionLike => ({ id, title, severity, dueDate });

describe("greeting", () => {
  it("uses the hour of day", () => {
    expect(greeting(5, "Sam")).toBe("Good morning, Sam");
    expect(greeting(11, "Sam")).toBe("Good morning, Sam");
    expect(greeting(12, "Sam")).toBe("Good afternoon, Sam");
    expect(greeting(17, "Sam")).toBe("Good afternoon, Sam");
    expect(greeting(18, "Sam")).toBe("Good evening, Sam");
    expect(greeting(2, "Sam")).toBe("Good evening, Sam");
  });
  it("works without a name or with a bad hour", () => {
    expect(greeting(9)).toBe("Good morning");
    expect(greeting(9, "  ")).toBe("Good morning");
    expect(greeting(NaN, "Al")).toBe("Good afternoon, Al");
  });
});

describe("attention ordering", () => {
  it("sorts by severity and keeps order within a severity", () => {
    const out = sortBySeverity([{ id: "a", severity: "info" as const }, { id: "b", severity: "high" as const }, { id: "c", severity: "review" as const }, { id: "d", severity: "high" as const }]);
    expect(out.map((x) => x.id)).toEqual(["b", "d", "c", "a"]);
  });
  it("collapses to the top five", () => {
    const { shown, rest } = collapse([1, 2, 3, 4, 5, 6, 7]);
    expect(shown).toEqual([1, 2, 3, 4, 5]);
    expect(rest).toEqual([6, 7]);
    expect(collapse([1, 2]).rest).toEqual([]);
  });
});

describe("dates", () => {
  it("parses real dates only", () => {
    expect(dayNumber("2026-10-03")).not.toBeNull();
    expect(dayNumber("2026-10-03T12:00:00Z")).toBe(dayNumber("2026-10-03"));
    expect(dayNumber("2026-02-30")).toBeNull();
    expect(dayNumber("soon")).toBeNull();
    expect(dayNumber(undefined)).toBeNull();
  });
  it("formats the local day key", () => {
    expect(todayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("selectUpcoming", () => {
  const today = "2026-10-03";
  it("keeps overdue and the next 30 days, sorted soonest first", () => {
    const out = selectUpcoming(
      [item("far", "2026-12-01"), item("edge", "2026-11-02"), item("late", "2026-10-01"), item("none", undefined), item("bad", "tomorrow"), item("soon", "2026-10-10"), item("today", "2026-10-03")],
      today,
    );
    expect(out.map((u) => u.item.id)).toEqual(["late", "today", "soon", "edge"]);
    expect(out[0].overdue).toBe(true);
    expect(out[0].daysUntil).toBe(-2);
    expect(out[3].daysUntil).toBe(30);
  });
  it("breaks ties by severity then title", () => {
    const out = selectUpcoming([item("b", "2026-10-05", "info"), item("a", "2026-10-05", "high"), item("c", "2026-10-05", "info")], today);
    expect(out.map((u) => u.item.id)).toEqual(["a", "b", "c"]);
  });
  it("returns nothing for a bad today", () => {
    expect(selectUpcoming([item("a", "2026-10-05")], "nope")).toEqual([]);
  });
  it("describes due-ness", () => {
    expect(describeDue(-3)).toBe("3 days overdue");
    expect(describeDue(-1)).toBe("1 day overdue");
    expect(describeDue(0)).toBe("Due today");
    expect(describeDue(1)).toBe("Due tomorrow");
    expect(describeDue(12)).toBe("Due in 12 days");
  });
});

describe("facts readers", () => {
  it("summarizes health by category and says null when absent", () => {
    expect(healthSummary({})).toBeNull();
    expect(healthSummary({ health: { counts: {} } })).toBeNull();
    const s = healthSummary({
      health: { counts: { Legal: { complete: 2, attention: 1, missing: 1, not_applicable: 3, unknown: 0 }, Money: { complete: 0, attention: 0, missing: 0, not_applicable: 4, unknown: 0 }, Security: { complete: 1, attention: 0, missing: 0, unknown: 2 } } },
    });
    expect(s?.rows.map((r) => r.category)).toEqual(["Legal", "Security"]);
    expect(s).toMatchObject({ complete: 3, attention: 1, missing: 1, unknown: 2 });
    expect(s?.rows[0].total).toBe(4);
  });

  it("reads a finance snapshot honestly", () => {
    expect(readSnapshot(undefined)).toBeNull();
    expect(readSnapshot({ source: "x" })).toBeNull();
    expect(readSnapshot({ cash: "1200.5", monthlyRevenue: 5000, monthlyExpenses: "oops", month: "2026-09", source: "manual" })).toEqual({
      cash: 1200.5, monthlyRevenue: 5000, monthlyExpenses: null, month: "2026-09", source: "manual",
    });
  });
  it("formats money, months and runway", () => {
    expect(formatMoney(12345.6)).toBe("$12,346");
    expect(formatMoney(-50)).toBe("-$50");
    expect(formatMoney(null)).toBe("Not entered");
    expect(formatMonth("2026-09")).toBe("September 2026");
    expect(formatMonth("Q3")).toBe("Q3");
    expect(formatMonth(null)).toBeNull();
    expect(formatRunway(null)).toBe("Not calculated");
    expect(formatRunway(1)).toBe("1 month");
    expect(formatRunway(7.26)).toBe("7.3 months");
  });
  it("builds the finance view", () => {
    expect(financeView({}).empty).toBe(true);
    const v = financeView({ finance: { latestRunwayMonths: 6, taxReserveConfigured: true, snapshot: { cash: 100 } } });
    expect(v).toMatchObject({ empty: false, runway: "6 months", taxReserve: "set up" });
    expect(v.snapshot?.cash).toBe(100);
    expect(financeView({ finance: { taxReserveConfigured: false, latestRunwayMonths: null } }).empty).toBe(true);
  });
  it("builds documents and tasks views", () => {
    expect(docsView({}).empty).toBe(true);
    expect(docsView({ vault: { documentCount: 3, expiringSoon: 1, expired: 0, documentsWithText: 2 } })).toMatchObject({ count: 3, expiringSoon: 1, empty: false });
    expect(tasksView({}).empty).toBe(true);
    expect(tasksView({ tasks: { open: 0, completedLast30Days: 2 } }).empty).toBe(false);
    expect(tasksView({ tasks: { open: 4, overdue: 1, dueThisWeek: 2 } })).toMatchObject({ open: 4, overdue: 1, dueThisWeek: 2 });
  });
});

describe("getting started", () => {
  it("derives done-ness from facts and flags", () => {
    const none = gettingStarted({});
    expect(none.doneCount).toBe(0);
    expect(none.complete).toBe(false);
    expect(none.steps.map((s) => s.key)).toEqual(["vault", "health", "compliance", "ask"]);
    const some = gettingStarted({ vault: { documentCount: 1 }, compliance: { itemCount: 0 } }, { healthVisited: true });
    expect(some.steps.filter((s) => s.done).map((s) => s.key)).toEqual(["vault", "health"]);
  });
  it("completes when all four are done", () => {
    const p = gettingStarted({ vault: { documentCount: 2 }, compliance: { itemCount: 5 } }, { healthVisited: true, askedBefore: true });
    expect(p).toMatchObject({ doneCount: 4, total: 4, complete: true });
  });
});

describe("commands", () => {
  it("shows commands for an empty query or a leading >", () => {
    expect(isCommandQuery("")).toBe(true);
    expect(isCommandQuery("  ")).toBe(true);
    expect(isCommandQuery(">")).toBe(true);
    expect(isCommandQuery("> task")).toBe(true);
    expect(isCommandQuery("task")).toBe(false);
  });
  it("lists every command for an empty filter", () => {
    expect(filterCommands("")).toHaveLength(COMMANDS.length);
    expect(filterCommands(">")).toHaveLength(COMMANDS.length);
  });
  it("filters by title, hint and keywords, title matches first", () => {
    expect(filterCommands("> new task")[0].id).toBe("new-task");
    expect(filterCommands(">settings").map((c) => c.id)).toContain("settings");
    expect(filterCommands("export").map((c) => c.id)).toEqual(["privacy"]);
    expect(filterCommands("zzzz")).toEqual([]);
    const ranked = filterCommands("contract").map((c) => c.id);
    expect(ranked[0]).toBe("review");
    expect(ranked).toContain("upload");
  });
  it("points only at in-app routes", () => {
    for (const c of COMMANDS) expect(c.href).toMatch(/^\/app\/[a-z/]+$/);
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });
  it("moves the highlight with wrap-around", () => {
    expect(moveIndex(0, 1, 3)).toBe(1);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});

describe("ask errors", () => {
  it("explains plan limits and unavailable AI", () => {
    expect(askErrorMessage(402)).toMatch(/plan limit/);
    expect(askErrorMessage(402, "Limit reached: 20 of 20")).toBe("Limit reached: 20 of 20");
    expect(askErrorMessage(503)).toMatch(/not available/);
    expect(askErrorMessage(500)).toMatch(/Could not send/);
    expect(askErrorMessage(429)).toMatch(/Too many/);
  });
});


describe("finance snapshot in the Finance tool's own shape (cents)", () => {
  it("converts cents to dollars and trims the month", () => {
    const s = readSnapshot({ month: "2026-09-01", revenueCents: 520000, expensesCents: 410000, cashCents: 1250000, source: "entered" });
    expect(s).toMatchObject({ cash: 12500, monthlyRevenue: 5200, monthlyExpenses: 4100, month: "2026-09", source: "entered" });
  });
  it("keeps a missing cash balance as null", () => {
    expect(readSnapshot({ month: "2026-09-01", revenueCents: 100, expensesCents: 50, cashCents: null })?.cash).toBeNull();
  });
});
