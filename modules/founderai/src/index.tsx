import { z } from "zod";
import { HttpError, json, readJson, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import Chat from "./ui/Chat";
import { confirmProposal, dismissProposal, extractProposals, insertProposals, listProposals, renderCatalog, validateProposals, wantsChange, type proposalOut } from "./proposals";
import {
  buildPrompt, extractActions, extractKeywords, numberTokens, rankSources, splitContextText, titleFrom, unsupportedClaims, validateCitations,
  type Action, type HistoryMessage, type StoredSource,
} from "./rag";

/** A pending answer older than this is given up on (the GPU may have been off for a long time). */
const PENDING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_CONVERSATIONS = 200;
const AI_OFF = "AI is not available for this business yet, so this question was saved but not answered. You can retry once AI is set up.";

interface ConvRow { id: string; title: string; created_at: Date; updated_at: Date }
interface MsgRow {
  id: string; conversation_id: string; seq: string; role: "user" | "assistant"; content: string; sources: StoredSource[];
  status: "pending" | "done" | "failed"; ai_job_id: string | null; error: string | null;
  meta: { pending?: { candidates: StoredSource[]; toolPages: string[]; grounding: string[]; propose?: boolean }; warnings?: string[]; actions?: Action[]; dropped?: number; proposalsIgnored?: number };
  created_at: Date;
}

const convOut = (c: ConvRow) => ({ id: c.id, title: c.title, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString() });
type ProposalOut = ReturnType<typeof proposalOut>;
const msgOut = (m: MsgRow, note?: string, proposals: ProposalOut[] = []) => ({
  id: m.id,
  conversationId: m.conversation_id,
  role: m.role,
  content: m.content,
  status: m.status,
  error: m.error,
  sources: m.status === "done" ? m.sources : [],
  warnings: m.meta.warnings ?? [],
  actions: m.meta.actions ?? [],
  proposals,
  proposalsIgnored: m.meta.proposalsIgnored ?? 0,
  note: note ?? null,
  createdAt: m.created_at.toISOString(),
});

const AskBody = z.object({ conversationId: z.string().regex(UUID_RE).optional(), content: z.string().trim().min(1).max(2000) });

/** A conversation belongs to one user within one business; anything else is a 404 so its existence is not revealed. */
async function ownConversation(ctx: ToolContext, id: string): Promise<ConvRow> {
  const [c] = await ctx.sql<ConvRow[]>`
    SELECT id, title, created_at, updated_at FROM founderai_conversations
    WHERE id = ${uuidParam(id)} AND business_id = ${ctx.businessId} AND user_id = ${ctx.userId}`;
  if (!c) throw new HttpError(404, "Not found");
  return c;
}

async function ownMessage(ctx: ToolContext, id: string): Promise<MsgRow> {
  const [m] = await ctx.sql<MsgRow[]>`
    SELECT m.id, m.conversation_id, m.seq, m.role, m.content, m.sources, m.status, m.ai_job_id, m.error, m.meta, m.created_at
    FROM founderai_messages m JOIN founderai_conversations c ON c.id = m.conversation_id
    WHERE m.id = ${uuidParam(id)} AND m.business_id = ${ctx.businessId} AND c.business_id = ${ctx.businessId} AND c.user_id = ${ctx.userId}`;
  if (!m) throw new HttpError(404, "Not found");
  return m;
}

async function historyBefore(ctx: ToolContext, conversationId: string, beforeSeq: string): Promise<HistoryMessage[]> {
  const rows = await ctx.sql<{ role: "user" | "assistant"; content: string }[]>`
    SELECT role, content FROM founderai_messages
    WHERE conversation_id = ${conversationId} AND business_id = ${ctx.businessId} AND seq < ${beforeSeq} AND (role = 'user' OR status = 'done')
    ORDER BY seq DESC LIMIT 6`;
  return rows.reverse();
}

async function fail(ctx: ToolContext, id: string, error: string): Promise<MsgRow> {
  const [m] = await ctx.sql<MsgRow[]>`
    UPDATE founderai_messages SET status = 'failed', error = ${error}, meta = meta - 'pending'
    WHERE id = ${id} AND business_id = ${ctx.businessId} AND status = 'pending' RETURNING *`;
  return m ?? (await ownMessage(ctx, id));
}

/** Builds the grounded prompt for a question and starts the AI job; the assistant row `assistantId` ends up pending (job started) or failed (could not start). */
async function launch(ctx: ToolContext, assistantId: string, question: string, history: HistoryMessage[]): Promise<MsgRow> {
  const bc = await ctx.context();
  const { head, summaries } = splitContextText(bc.asText(), tool.name);
  // Actions are offered to the model only when the user's question asks for a change and their role may make one.
  const propose = ctx.canWrite && wantsChange(question, history);
  const catalog = propose ? renderCatalog(ctx.actions) : "";
  const groups = (await Promise.all([question, ...extractKeywords(question)].map((q) => ctx.search(q.slice(0, 200), 3)))).flat();
  const built = buildPrompt({
    head,
    summaries,
    attention: bc.attention,
    sources: rankSources(groups),
    toolPages: [...new Set([...Object.keys(bc.summaries), ...Object.keys(bc.facts)])].filter((t) => /^[a-z]+$/.test(t) && t !== "legal" && t !== "founderai").sort().map((t) => `/app/t/${t}`),
    history,
    question,
    catalog: catalog || undefined,
  });
  let jobId: string;
  try {
    ({ jobId } = await ctx.ai.start({ system: built.system, prompt: built.prompt, tier: "deep" }));
  } catch {
    return fail(ctx, assistantId, "The AI service could not take this question. It is saved; try again in a moment.");
  }
  const pending = {
    candidates: built.sources.map(({ snippet: _s, ...rest }) => rest),
    toolPages: built.toolPages,
    grounding: numberTokens(built.prompt).slice(0, 3000),
    propose: !!catalog,
  };
  const [m] = await ctx.sql<MsgRow[]>`
    UPDATE founderai_messages SET status = 'pending', error = NULL, ai_job_id = ${jobId}, content = '', sources = '[]'::jsonb,
      meta = ${ctx.sql.json({ pending } as never)}, created_at = now()
    WHERE id = ${assistantId} AND business_id = ${ctx.businessId} RETURNING *`;
  return m;
}

/** Validates the model's answer against what it was given, then stores it. */
async function finish(ctx: ToolContext, m: MsgRow, text: string): Promise<MsgRow> {
  const p = m.meta.pending;
  if (!text.trim() || !p) return fail(ctx, m.id, "The assistant returned an empty answer. Try asking again.");
  // The proposal block never reaches the user as text. Proposals are validated and previewed here but only a click runs anything.
  const ex = extractProposals(text.trim());
  const proposalsAllowed = !!p.propose && ctx.canWrite;
  const { drafts, dropped: proposalsDropped } = proposalsAllowed ? await validateProposals(ctx, ex.proposals) : { drafts: [], dropped: ex.proposals.length };
  const answer = ex.text || (drafts.length ? "Here is what I suggest. Nothing changes until you confirm it." : "");
  if (!answer.trim()) return fail(ctx, m.id, "The assistant returned an empty answer. Try asking again.");
  const byNumber = new Map(p.candidates.map((s) => [s.n, s]));
  const v = validateCitations(answer, new Set(byNumber.keys()));
  const cited = v.cited.map((n) => byNumber.get(n)!);
  const warnings: string[] = [];
  const claims = unsupportedClaims(v.text, new Set(p.grounding));
  if (claims.length) warnings.push(`This answer mentions figures or dates that were not found in your connected company data (${claims.join("; ")}). Check them against your own records before relying on them.`);
  const actions = extractActions(v.text, new Set(p.candidates.map((s) => s.href)), new Set([...p.toolPages.map((t) => t.replace("/app/t/", "")), ...p.candidates.map((s) => s.tool)]));
  const [done] = await ctx.sql<MsgRow[]>`
    UPDATE founderai_messages SET status = 'done', content = ${v.text}, sources = ${ctx.sql.json(cited as never)},
      meta = ${ctx.sql.json({ warnings, actions, dropped: v.dropped, proposalsIgnored: proposalsDropped + ex.ignored } as never)}, error = NULL
    WHERE id = ${m.id} AND business_id = ${ctx.businessId} AND status = 'pending' RETURNING *`;
  if (done && drafts.length) await insertProposals(ctx, done, drafts);
  return done ?? (await ownMessage(ctx, m.id));
}

export const tool: ToolDef = {
  id: "founderai",
  name: "Ask FounderOS",
  description: "An assistant grounded in your business and every tool. It answers, suggests where to go next, and can propose changes (like a new task) that only happen when you confirm them. It is not a lawyer, accountant or financial adviser.",
  group: "business",
  status: "live",
  migrations: [
    {
      name: "0001_conversations",
      sql: `CREATE TABLE founderai_conversations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id     text NOT NULL,
        title       text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX founderai_conversations_user ON founderai_conversations (business_id, user_id, updated_at DESC);
      CREATE TABLE founderai_messages (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq             bigserial,
        business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES founderai_conversations(id) ON DELETE CASCADE,
        role            text NOT NULL CHECK (role IN ('user', 'assistant')),
        content         text NOT NULL DEFAULT '',
        sources         jsonb NOT NULL DEFAULT '[]',
        status          text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'failed')),
        ai_job_id       text,
        error           text,
        meta            jsonb NOT NULL DEFAULT '{}',
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX founderai_messages_conversation ON founderai_messages (conversation_id, seq);`,
    },
    {
      name: "0002_proposals",
      sql: `CREATE TABLE founderai_proposals (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id         text NOT NULL,
        conversation_id uuid NOT NULL REFERENCES founderai_conversations(id) ON DELETE CASCADE,
        message_id      uuid NOT NULL REFERENCES founderai_messages(id) ON DELETE CASCADE,
        position        int NOT NULL DEFAULT 0,
        tool_id         text NOT NULL,
        action_id       text NOT NULL,
        input           jsonb NOT NULL,
        preview         jsonb NOT NULL,
        status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'dismissed', 'failed')),
        result          jsonb,
        error           text,
        decided_by      text,
        decided_at      timestamptz,
        idempotency_key text NOT NULL UNIQUE,
        expires_at      timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX founderai_proposals_message ON founderai_proposals (business_id, user_id, message_id, position);`,
    },
  ],

  api: route({
    "GET conversations": async (ctx) => {
      const rows = await ctx.sql<ConvRow[]>`
        SELECT id, title, created_at, updated_at FROM founderai_conversations
        WHERE business_id = ${ctx.businessId} AND user_id = ${ctx.userId} ORDER BY updated_at DESC LIMIT 100`;
      return json({ conversations: rows.map(convOut), aiAvailable: ctx.ai.available });
    },

    "GET conversations/:id": async (ctx, _req, p) => {
      const c = await ownConversation(ctx, p.id);
      const rows = await ctx.sql<MsgRow[]>`
        SELECT id, conversation_id, seq, role, content, sources, status, ai_job_id, error, meta, created_at FROM founderai_messages
        WHERE conversation_id = ${c.id} AND business_id = ${ctx.businessId} ORDER BY seq LIMIT 400`;
      const props = await listProposals(ctx, rows.filter((m) => m.role === "assistant").map((m) => m.id));
      return json({ conversation: convOut(c), messages: rows.map((m) => msgOut(m, undefined, props.get(m.id))), aiAvailable: ctx.ai.available });
    },

    "DELETE conversations/:id": async (ctx, _req, p) => {
      const c = await ownConversation(ctx, p.id);
      await ctx.sql`DELETE FROM founderai_conversations WHERE id = ${c.id} AND business_id = ${ctx.businessId} AND user_id = ${ctx.userId}`;
      return json({ ok: true });
    },

    // Ask a question. Viewers may ask: the assistant only reads data they can already see, and these rows are their own chat history,
    // not business data, so requireWrite is deliberately not used here.
    "POST messages": async (ctx, req) => {
      const body = await readJson(req, AskBody);
      let conv: ConvRow;
      if (body.conversationId) {
        conv = await ownConversation(ctx, body.conversationId);
        const [{ n, pending }] = await ctx.sql<{ n: number; pending: number }[]>`
          SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'pending')::int AS pending FROM founderai_messages WHERE conversation_id = ${conv.id} AND business_id = ${ctx.businessId}`;
        if (pending > 0) throw new HttpError(409, "Wait for the current answer to finish first.");
        if (n >= MAX_MESSAGES_PER_CONVERSATION) throw new HttpError(400, "This conversation is long. Start a new one.");
      } else {
        const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM founderai_conversations WHERE business_id = ${ctx.businessId} AND user_id = ${ctx.userId}`;
        if (n >= MAX_CONVERSATIONS) throw new HttpError(400, "Too many conversations. Delete some you no longer need.");
        [conv] = await ctx.sql<ConvRow[]>`
          INSERT INTO founderai_conversations (business_id, user_id, title) VALUES (${ctx.businessId}, ${ctx.userId}, ${titleFrom(body.content)})
          RETURNING id, title, created_at, updated_at`;
      }
      const [userMsg] = await ctx.sql<MsgRow[]>`
        INSERT INTO founderai_messages (business_id, conversation_id, role, content, status) VALUES (${ctx.businessId}, ${conv.id}, 'user', ${body.content}, 'done')
        RETURNING *`;
      const [asst] = await ctx.sql<MsgRow[]>`
        INSERT INTO founderai_messages (business_id, conversation_id, role, status) VALUES (${ctx.businessId}, ${conv.id}, 'assistant', 'pending')
        RETURNING *`;
      await ctx.sql`UPDATE founderai_conversations SET updated_at = now() WHERE id = ${conv.id} AND business_id = ${ctx.businessId}`;
      const assistantMessage = ctx.ai.available
        ? await launch(ctx, asst.id, body.content, await historyBefore(ctx, conv.id, userMsg.seq))
        : await fail(ctx, asst.id, AI_OFF);
      return json({ conversation: convOut(conv), userMessage: msgOut(userMsg), assistantMessage: msgOut(assistantMessage), aiAvailable: ctx.ai.available }, 201);
    },

    // Poll an answer. While the model works this just reports progress; when it finishes, the answer is validated and stored.
    "GET messages/:id": async (ctx, _req, p) => {
      let m = await ownMessage(ctx, p.id);
      let note: string | undefined;
      if (m.role === "assistant" && m.status === "pending") {
        if (Date.now() - m.created_at.getTime() > PENDING_TIMEOUT_MS || !m.ai_job_id) {
          m = await fail(ctx, m.id, "This took too long and was given up on. Your question is saved; retry it.");
        } else {
          let st: Awaited<ReturnType<typeof ctx.ai.poll>> | undefined;
          try {
            st = await ctx.ai.poll(m.ai_job_id);
          } catch {
            note = "Could not reach the AI service just now. Still trying.";
          }
          if (st?.state === "done") m = await finish(ctx, m, st.text);
          else if (st?.state === "failed") m = await fail(ctx, m.id, "The AI could not finish this answer. Your question is saved; retry it.");
          else if (st?.state === "waiting") note = st.message;
        }
      }
      const props = m.role === "assistant" ? await listProposals(ctx, [m.id]) : new Map();
      return json({ message: msgOut(m, note, props.get(m.id)) });
    },

    // Retry a failed answer for a question that is already saved.
    "POST messages/:id/retry": async (ctx, _req, p) => {
      const m = await ownMessage(ctx, p.id);
      if (m.role !== "assistant" || m.status !== "failed") throw new HttpError(400, "Only a failed answer can be retried.");
      if (!ctx.ai.available) throw new HttpError(503, AI_OFF);
      const [q] = await ctx.sql<{ seq: string; content: string }[]>`
        SELECT seq, content FROM founderai_messages WHERE conversation_id = ${m.conversation_id} AND business_id = ${ctx.businessId} AND role = 'user' AND seq < ${m.seq}
        ORDER BY seq DESC LIMIT 1`;
      if (!q) throw new HttpError(400, "The question for this answer is missing.");
      await ctx.sql`UPDATE founderai_messages SET status = 'pending', error = NULL WHERE id = ${m.id} AND business_id = ${ctx.businessId}`;
      const next = await launch(ctx, m.id, q.content, await historyBefore(ctx, m.conversation_id, q.seq));
      await ctx.sql`UPDATE founderai_conversations SET updated_at = now() WHERE id = ${m.conversation_id} AND business_id = ${ctx.businessId}`;
      return json({ message: msgOut(next) });
    },

    // The only way anything an answer suggested ever happens: the user's own click. Never callable by the model.
    "POST proposals/:id/confirm": async (ctx, _req, p) => json(await confirmProposal(ctx, uuidParam(p.id))),
    "POST proposals/:id/dismiss": async (ctx, _req, p) => json({ proposal: await dismissProposal(ctx, uuidParam(p.id)) }),
  }),

  async Page({ ctx, path }) {
    const rows = await ctx.sql<ConvRow[]>`
      SELECT id, title, created_at, updated_at FROM founderai_conversations
      WHERE business_id = ${ctx.businessId} AND user_id = ${ctx.userId} ORDER BY updated_at DESC LIMIT 100`;
    const initialId = path[0] && UUID_RE.test(path[0]) ? path[0] : undefined;
    return <Chat initialConversations={rows.map(convOut)} initialId={initialId} aiAvailable={ctx.ai.available} />;
  },

  // Conversations are private to their author, so everything this tool publishes about them (describe, facts, search, resolve) is scoped to the
  // current user too. Nothing here is ever visible to other members.
  async describe(ctx) {
    const rows = await ctx.sql<{ title: string }[]>`
      SELECT title FROM founderai_conversations WHERE business_id = ${ctx.businessId} AND user_id = ${ctx.userId} ORDER BY updated_at DESC LIMIT 100`;
    if (rows.length === 0) return "";
    const topics = rows.slice(0, 3).map((r) => r.title.replace(/[;\n]/g, " ")).join("; ");
    return `${rows.length} conversation${rows.length === 1 ? "" : "s"} with the assistant; recent topics: ${topics}.`.slice(0, 600);
  },

  async facts(ctx) {
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM founderai_conversations WHERE business_id = ${ctx.businessId} AND user_id = ${ctx.userId}`;
    return { conversationCount: n };
  },

  async attention(): Promise<AttentionItem[]> {
    return [];
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [c] = await ctx.sql<{ title: string }[]>`SELECT title FROM founderai_conversations WHERE id = ${id} AND business_id = ${ctx.businessId} AND user_id = ${ctx.userId}`;
    return c ? { title: c.title, href: `/app/t/founderai/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[%_\\]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; title: string }[]>`
      SELECT id, title FROM founderai_conversations WHERE business_id = ${ctx.businessId} AND user_id = ${ctx.userId} AND title ILIKE ${like}
      ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: "Conversation with the assistant", href: `/app/t/founderai/${r.id}` }));
  },
};
