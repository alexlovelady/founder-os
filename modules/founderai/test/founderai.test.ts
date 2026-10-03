import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPlatform, type AiClient, type ToolContext, type ToolDef } from "@founderos/sdk";
import { FakeAi, call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { buildPrompt, extractKeywords, MAX_PROMPT_CHARS, numberTokens, rankSources, SYSTEM_PROMPT, unsupportedClaims, validateCitations } from "../src/rag";

// A second tool defined inside the test, standing in for "the rest of the business".
const BIG = "x".repeat(580);
let fakeDescribe = "Customer Acme Plumbing has an open invoice of $4,200 due 2026-11-15. Two contractors are on file.";
const fake: ToolDef = {
  id: "fakecrm",
  name: "Fake CRM",
  description: "test double",
  group: "growth",
  status: "live",
  describe: async () => fakeDescribe,
  facts: async () => ({ openInvoices: 1 }),
  attention: async () => [{ id: "a1", title: "Invoice overdue for Acme", detail: "Follow up", severity: "high", href: "/app/t/fakecrm" }],
  search: async (_ctx, q) => (q.toLowerCase().includes("acme") ? [{ id: "c1", title: "Acme Plumbing", snippet: "Customer since 2024", href: "/app/t/fakecrm/contacts/c1" }] : []),
};

let env: TestEnv;
let ai: FakeAi;
const post = (ctx: ToolContext, content: string, conversationId?: string) => call(tool, ctx, "POST", "messages", { content, conversationId });
const poll = (ctx: ToolContext, id: string) => call(tool, ctx, "GET", `messages/${id}`);
const secondMember = (): ToolContext => withPlatform({ ...env.ctx, userId: "second-member" } as ToolContext, [tool, fake]);

beforeAll(async () => {
  env = await makeTestEnv([tool, fake]);
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  fakeDescribe = "Customer Acme Plumbing has an open invoice of $4,200 due 2026-11-15. Two contractors are on file.";
  ai = new FakeAi([], "Answer.");
  env.ctx.ai = ai;
  env.other.ai = ai;
  await env.sql`DELETE FROM founderai_conversations WHERE business_id IN (${env.ctx.businessId}, ${env.other.businessId})`;
});

describe("grounding the prompt", () => {
  it("puts the business context, attention and search hits (numbered, with links) into the prompt", async () => {
    const r = await post(env.ctx, "What do my documents say about Acme?");
    expect(r.status).toBe(201);
    expect(r.data.assistantMessage.status).toBe("pending");
    const req = ai.calls[0];
    expect(req.tier).toBe("deep");
    expect(req.prompt).toContain("Test Co A");
    expect(req.prompt).toContain("Fake CRM: Customer Acme Plumbing has an open invoice of $4,200");
    expect(req.prompt).toContain("Invoice overdue for Acme");
    expect(req.prompt).toMatch(/\[S1\] Fake CRM: Acme Plumbing - Customer since 2024 \(\/app\/t\/fakecrm\/contacts\/c1\)/);
    expect(req.prompt).toContain("/app/t/fakecrm");
    expect(req.prompt).not.toContain("Ask FounderOS:"); // its own describe is not business data
    expect(req.system).toMatch(/NOT a lawyer, accountant or financial adviser/);
    expect(req.system).toContain("I don't have that information");
    expect(req.system).toMatch(/\[S1\]/);
    expect((req.system ?? "").length + req.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("finds sources by keyword when the whole question matches nothing", async () => {
    await post(env.ctx, "Is Acme current on payments, honestly?");
    expect(ai.calls[0].prompt).toContain("[S1] Fake CRM: Acme Plumbing");
  });

  it("says plainly when nothing was found, and includes recent history", async () => {
    const first = await post(env.ctx, "Remember the number 42 for later please");
    await poll(env.ctx, first.data.assistantMessage.id);
    await post(env.ctx, "And what was the thing I said earlier?", first.data.conversation.id);
    const p = ai.calls[1].prompt;
    expect(p).toContain("SOURCES: none found");
    expect(p).toContain("User: Remember the number 42");
    expect(p).toContain("Assistant: Answer.");
    expect(p.indexOf("CONVERSATION SO FAR")).toBeLessThan(p.indexOf("QUESTION:"));
  });

  it("keeps the whole request under the size cap with huge context and long history, trimming low-value parts first", async () => {
    fakeDescribe = BIG;
    let convId: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await post(env.ctx, `Acme question ${i} ${"y".repeat(1400)}`, convId);
      convId = r.data.conversation.id;
      await poll(env.ctx, r.data.assistantMessage.id);
    }
    const req = ai.calls[4];
    expect(req.system!.length + req.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(req.prompt).toContain("Acme question 4"); // the question itself is never dropped
    expect(req.prompt).toContain("Test Co A"); // nor the profile
  });

  it("buildPrompt drops the lowest-ranked sources first so numbering stays stable", () => {
    const sources = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, tool: "t", toolName: "T", title: `Doc ${i + 1}`, snippet: "s".repeat(200), href: `/app/t/t/${i + 1}` }));
    const out = buildPrompt({
      head: "Business: X", summaries: Array.from({ length: 10 }, (_, i) => `- Tool${i}: ${"z".repeat(600)}`), attention: [], sources, toolPages: ["/app/t/t"],
      history: Array.from({ length: 6 }, () => ({ role: "user" as const, content: "h".repeat(500) })), question: "q".repeat(5000),
    });
    expect(out.system.length + out.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(out.sources.map((s) => s.n)).toEqual(out.sources.map((_, i) => i + 1));
    expect(out.prompt).toContain("QUESTION:");
    expect(SYSTEM_PROMPT.length).toBeLessThan(2000);
  });
});

describe("answers", () => {
  const ask = async (reply: string, q = "Tell me about Acme") => {
    ai = new FakeAi([reply]);
    env.ctx.ai = ai;
    const r = await post(env.ctx, q);
    const done = await poll(env.ctx, r.data.assistantMessage.id);
    return { r, msg: done.data.message };
  };

  it("keeps real citations, drops invented ones, and lists only the sources actually cited", async () => {
    const { msg } = await ask("From your data: Acme has an open invoice [S1]. Also [S7] and [S1, S9].");
    expect(msg.status).toBe("done");
    expect(msg.content).toContain("[S1]");
    expect(msg.content).not.toContain("S7");
    expect(msg.content).not.toContain("S9");
    expect(msg.sources).toEqual([{ n: 1, tool: "fakecrm", toolName: "Fake CRM", title: "Acme Plumbing", href: "/app/t/fakecrm/contacts/c1" }]);
  });

  it("attaches no sources when the answer cites none", async () => {
    const { msg } = await ask("General information only.");
    expect(msg.sources).toEqual([]);
  });

  it("warns about figures and dates that are not in the company data, but not about ones that are", async () => {
    const bad = await ask("Acme owes $9,999 and it is due 2027-01-01 [S1].");
    expect(bad.msg.warnings).toHaveLength(1);
    expect(bad.msg.warnings[0]).toMatch(/\$9,999/);
    const good = await ask("Acme has an open invoice of $4,200 due 2026-11-15 [S1]; you have 2 contractors.");
    expect(good.msg.warnings).toEqual([]);
  });

  it("turns only offered links into suggested actions", async () => {
    const { msg } = await ask("Next: [Open the contact](/app/t/fakecrm/contacts/c1), see /app/t/fakecrm, ignore [x](/app/t/bogus) and [bad](https://evil.example/x).");
    expect(msg.actions).toEqual([
      { label: "Open the contact", href: "/app/t/fakecrm/contacts/c1" },
      { label: "Open fakecrm", href: "/app/t/fakecrm" },
    ]);
  });

  it("fails an empty answer so it can be retried", async () => {
    const { msg } = await ask("   ");
    expect(msg.status).toBe("failed");
  });

  it("is read-only: a conversation is the only thing a question writes", async () => {
    const before = await env.sql`SELECT count(*)::int AS n FROM entity_links WHERE business_id = ${env.ctx.businessId}`;
    await ask("Please delete all my contacts [S1]");
    const after = await env.sql`SELECT count(*)::int AS n FROM entity_links WHERE business_id = ${env.ctx.businessId}`;
    expect(after[0].n).toBe(before[0].n);
  });
});

describe("AI availability and failure", () => {
  it("saves the question and shows a clear status when AI is unavailable; retry works once it is back", async () => {
    ai.available = false;
    const r = await post(env.ctx, "What should I work on this week?");
    expect(r.status).toBe(201);
    expect(r.data.aiAvailable).toBe(false);
    expect(r.data.assistantMessage.status).toBe("failed");
    expect(r.data.assistantMessage.error).toMatch(/not available/);
    expect(ai.calls).toHaveLength(0);
    expect((await call(tool, env.ctx, "POST", `messages/${r.data.assistantMessage.id}/retry`)).status).toBe(503);
    const saved = await call(tool, env.ctx, "GET", `conversations/${r.data.conversation.id}`);
    expect(saved.data.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);

    ai.available = true;
    const retried = await call(tool, env.ctx, "POST", `messages/${r.data.assistantMessage.id}/retry`);
    expect(retried.data.message.status).toBe("pending");
    expect((await poll(env.ctx, r.data.assistantMessage.id)).data.message.status).toBe("done");
    expect(ai.calls[0].prompt).toContain("What should I work on this week?");
    expect((await call(tool, env.ctx, "POST", `messages/${r.data.assistantMessage.id}/retry`)).status).toBe(400); // no longer failed
  });

  it("keeps the question when the AI service refuses to start", async () => {
    env.ctx.ai = { available: true, start: async () => { throw new Error("boom secret"); }, poll: async () => ({ state: "running" }) } satisfies AiClient;
    const r = await post(env.ctx, "Hello there");
    expect(r.data.assistantMessage.status).toBe("failed");
    expect(r.data.assistantMessage.error).not.toContain("secret");
    expect(r.data.userMessage.content).toBe("Hello there");
  });

  it("reports the GPU being offline as progress, then a failed job as retryable", async () => {
    let state: Awaited<ReturnType<AiClient["poll"]>> = { state: "waiting", message: "Your private AI computer is offline." };
    env.ctx.ai = { available: true, start: async () => ({ jobId: "j1" }), poll: async () => state };
    const r = await post(env.ctx, "Summarize my business risks");
    const id = r.data.assistantMessage.id;
    expect((await poll(env.ctx, id)).data.message).toMatchObject({ status: "pending", note: "Your private AI computer is offline." });
    state = { state: "running" };
    expect((await poll(env.ctx, id)).data.message).toMatchObject({ status: "pending", note: null });
    state = { state: "failed", error: "gpu exploded with internals" };
    const failed = (await poll(env.ctx, id)).data.message;
    expect(failed.status).toBe("failed");
    expect(failed.error).not.toContain("internals");
  });

  it("gives up on an answer that has been pending too long", async () => {
    env.ctx.ai = { available: true, start: async () => ({ jobId: "j1" }), poll: async () => ({ state: "running" }) };
    const r = await post(env.ctx, "Anything");
    await env.sql`UPDATE founderai_messages SET created_at = now() - interval '2 hours' WHERE id = ${r.data.assistantMessage.id}`;
    expect((await poll(env.ctx, r.data.assistantMessage.id)).data.message.status).toBe("failed");
  });

  it("allows only one unanswered question at a time per conversation", async () => {
    env.ctx.ai = { available: true, start: async () => ({ jobId: "j1" }), poll: async () => ({ state: "running" }) };
    const r = await post(env.ctx, "First");
    expect((await post(env.ctx, "Second", r.data.conversation.id)).status).toBe(409);
  });

  it("validates input", async () => {
    expect((await post(env.ctx, "")).status).toBe(400);
    expect((await post(env.ctx, "x".repeat(2001))).status).toBe(400);
    expect((await post(env.ctx, "hi", "not-a-uuid")).status).toBe(400);
    expect((await post(env.ctx, "hi", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await poll(env.ctx, "nope")).status).toBe(404);
  });
});

describe("privacy", () => {
  it("hides a conversation from other members of the same business and from other businesses", async () => {
    const mine = await post(env.ctx, "Private strategy question about Acme");
    const convId = mine.data.conversation.id;
    const msgId = mine.data.assistantMessage.id;
    const member = secondMember();
    for (const who of [member, env.other]) {
      expect((await call(tool, who, "GET", "conversations")).data.conversations).toEqual([]);
      expect((await call(tool, who, "GET", `conversations/${convId}`)).status).toBe(404);
      expect((await poll(who, msgId)).status).toBe(404);
      expect((await call(tool, who, "POST", `messages/${msgId}/retry`)).status).toBe(404);
      expect((await post(who, "sneaky", convId)).status).toBe(404);
      expect((await call(tool, who, "DELETE", `conversations/${convId}`)).status).toBe(404);
      expect(await tool.resolve!(who, convId)).toBeNull();
      expect(await tool.search!(who, "Private", 5)).toEqual([]);
      expect(await tool.describe!(who)).toBe("");
      expect(await tool.facts!(who)).toEqual({ conversationCount: 0 });
      expect((await who.context()).summaries.founderai).toBeUndefined();
    }
    // still intact for the owner
    expect((await call(tool, env.ctx, "GET", `conversations/${convId}`)).status).toBe(200);
  });
});

describe("viewers", () => {
  it("may ask questions and read their own conversations (the assistant is read-only), but see nobody else's", async () => {
    const viewer = await makeTestEnv([tool, fake], { role: "viewer", ai: new FakeAi([], "Fine [S1].") });
    try {
      const r = await post(viewer.ctx, "What do I owe Acme?");
      expect(r.status).toBe(201);
      expect((await poll(viewer.ctx, r.data.assistantMessage.id)).data.message.status).toBe("done");
      expect((await call(tool, viewer.ctx, "GET", `conversations/${r.data.conversation.id}`)).data.messages).toHaveLength(2);
      expect((await call(tool, viewer.ctx, "DELETE", `conversations/${r.data.conversation.id}`)).status).toBe(200);
      expect((await call(tool, viewer.other, "GET", "conversations")).data.conversations).toEqual([]);
    } finally {
      await viewer.cleanup();
    }
  });
});

describe("deletion and what the tool publishes", () => {
  it("deletes a conversation with its messages", async () => {
    const r = await post(env.ctx, "Delete me");
    const id = r.data.conversation.id;
    expect((await call(tool, env.ctx, "DELETE", `conversations/${id}`)).data).toEqual({ ok: true });
    expect((await call(tool, env.ctx, "GET", `conversations/${id}`)).status).toBe(404);
    const [{ n }] = await env.sql`SELECT count(*)::int AS n FROM founderai_messages WHERE conversation_id = ${id}`;
    expect(n).toBe(0);
    expect((await call(tool, env.ctx, "DELETE", `conversations/${id}`)).status).toBe(404);
  });

  it("publishes describe, facts, resolve and search for the user's own conversations", async () => {
    expect(await tool.describe!(env.ctx)).toBe("");
    const a = await post(env.ctx, "Hiring a contractor in Charlotte");
    await post(env.ctx, "Quarterly tax planning");
    expect(await tool.facts!(env.ctx)).toEqual({ conversationCount: 2 });
    expect(await tool.describe!(env.ctx)).toMatch(/^2 conversations with the assistant; recent topics: .*tax planning.*contractor/i);
    expect(await tool.resolve!(env.ctx, a.data.conversation.id)).toEqual({ title: "Hiring a contractor in Charlotte", href: `/app/t/founderai/${a.data.conversation.id}` });
    expect(await tool.resolve!(env.ctx, "garbage")).toBeNull();
    const hits = (await env.ctx.search("contractor")).flatMap((g) => g.hits.map((h) => h.title));
    expect(hits).toContain("Hiring a contractor in Charlotte");
    expect(await tool.attention!(env.ctx)).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("extracts keywords, ranks and interleaves sources, ignoring own conversations and foreign links", () => {
    expect(extractKeywords("What should I work on this week regarding invoices?")).toEqual(["regarding", "invoices"]);
    const s = rankSources([
      { tool: "a", toolName: "A", hits: [{ id: "1", title: "a1", href: "/app/t/a/1" }, { id: "2", title: "a2", href: "/app/t/a/2" }] },
      { tool: "b", toolName: "B", hits: [{ id: "1", title: "b1", href: "https://x.test" }, { id: "2", title: "b2", href: "/app/t/b/2" }] },
      { tool: "founderai", toolName: "Ask", hits: [{ id: "1", title: "chat", href: "/app/t/founderai/1" }] },
    ]);
    expect(s.map((x) => `${x.n}:${x.title}`)).toEqual(["1:a1", "2:b2", "3:a2"]);
  });
  it("validates citation lists and tokenises numbers", () => {
    expect(validateCitations("A [S1, S4] b [S3] c.", new Set([1, 2]))).toEqual({ text: "A [S1] b c.", cited: [1], dropped: 2 });
    expect(numberTokens("$1,200.50 and 03 and 2026-11-15 /app/t/x/123 [S4]")).toEqual(["1200.5", "3", "2026", "11", "15"]);
    expect(unsupportedClaims("Revenue grew 40% to $1,200", new Set(["1200"]))).toEqual(["40%"]);
  });
});
