import { normalizeFromSource } from "./normalize";
import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type Sql, type ToolContext, type ToolDef } from "@founderos/sdk";
import { isIsoDate, nextDueDate, RECURRENCES, type Recurrence } from "./dates";
import TasksBoard from "./ui/TasksBoard";

const STATUSES = ["todo", "in_progress", "done"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;
const SOURCES = ["manual", "ai", "compliance", "document", "crm", "finance", "system"] as const;

const dateStr = z.string().refine(isIsoDate, "Use a date like 2026-12-31");
const title = z.string().trim().min(1, "Title is required").max(300);
const description = z.string().trim().max(5000);
const assignee = z.string().trim().min(1).max(100);

const CreateBody = z.object({
  title,
  description: description.optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueDate: dateStr.nullish(),
  assignedTo: assignee.nullish(),
  recurrence: z.enum(RECURRENCES).optional(),
  status: z.enum(STATUSES).optional(),
});

const UpdateBody = z
  .object({
    title: title.optional(),
    description: description.optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: dateStr.nullable().optional(),
    assignedTo: assignee.nullable().optional(),
    recurrence: z.enum(RECURRENCES).optional(),
    status: z.enum(STATUSES).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");

// sourceRef is only a pair of strings: tasks never checks anything about the other tool.
const SourceRef = z.object({ tool: z.string().regex(/^[a-z]{1,40}$/, "tool must be a lowercase tool id"), id: z.string().trim().min(1).max(100) });
const FromSource = z.object({
  title,
  description: description.optional(),
  dueDate: dateStr.nullish(),
  priority: z.enum(PRIORITIES).optional(),
  source: z.enum(SOURCES.filter((s) => s !== "manual") as ["ai", "compliance", "document", "crm", "finance", "system"]),
  sourceRef: SourceRef.optional(),
  recurrence: z.enum(RECURRENCES).optional(),
});
const FromSourceBody = z.union([FromSource, z.object({ tasks: z.array(FromSource).min(1).max(50) })]);

interface Row {
  id: string;
  title: string;
  description: string;
  status: (typeof STATUSES)[number];
  priority: (typeof PRIORITIES)[number];
  due_date: string | null;
  assigned_to: string | null;
  source: string;
  source_ref: { tool: string; id: string } | null;
  recurrence: Recurrence;
  created_by: string;
  completed_at: Date | null;
  created_at: Date;
}

const cols = (sql: Sql) => sql`id, title, description, status, priority, to_char(due_date, 'YYYY-MM-DD') AS due_date, assigned_to, source, source_ref, recurrence, created_by, completed_at, created_at`;

const out = (r: Row) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  dueDate: r.due_date,
  assignedTo: r.assigned_to,
  source: r.source,
  sourceRef: r.source_ref,
  recurrence: r.recurrence,
  createdBy: r.created_by,
  completedAt: r.completed_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

async function dbToday(sql: Sql): Promise<string> {
  const [r] = await sql<{ d: string }[]>`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`;
  return r.d;
}

async function insertTask(
  sql: Sql,
  ctx: ToolContext,
  t: { title: string; description?: string; status?: string; priority?: string; dueDate?: string | null; assignedTo?: string | null; source?: string; sourceRef?: { tool: string; id: string } | null; recurrence?: string; createdBy?: string },
): Promise<Row> {
  const done = t.status === "done";
  const [row] = await sql<Row[]>`
    INSERT INTO tasks_items (business_id, title, description, status, priority, due_date, assigned_to, source, source_ref, recurrence, created_by, completed_at)
    VALUES (${ctx.businessId}, ${t.title}, ${t.description ?? ""}, ${t.status ?? "todo"}, ${t.priority ?? "medium"}, ${t.dueDate ?? null}, ${t.assignedTo ?? null},
            ${t.source ?? "manual"}, ${t.sourceRef ? sql.json(t.sourceRef) : null}, ${t.recurrence ?? "none"}, ${t.createdBy ?? ctx.userId}, ${done ? sql`now()` : null})
    RETURNING ${cols(sql)}`;
  return row;
}

/** Apply a change. Moving a task to done stamps completed_at and, for recurring tasks, creates the next one (once, even if called twice at the same time). */
async function applyUpdate(ctx: ToolContext, id: string, patch: z.infer<typeof UpdateBody>) {
  const today = await dbToday(ctx.sql);
  return ctx.sql.begin(async (tx) => {
    const [cur] = await tx<Row[]>`SELECT ${cols(tx as unknown as Sql)} FROM tasks_items WHERE id = ${id} AND business_id = ${ctx.businessId} FOR UPDATE`;
    if (!cur) throw new HttpError(404, "Not found");
    const status = patch.status ?? cur.status;
    const completing = status === "done" && cur.status !== "done";
    const completedAt = status !== "done" ? null : completing ? new Date() : cur.completed_at;
    const sql = tx as unknown as Sql;
    const [row] = await sql<Row[]>`
      UPDATE tasks_items SET
        title = ${patch.title ?? cur.title},
        description = ${patch.description ?? cur.description},
        status = ${status},
        priority = ${patch.priority ?? cur.priority},
        due_date = ${patch.dueDate === undefined ? cur.due_date : patch.dueDate},
        assigned_to = ${patch.assignedTo === undefined ? cur.assigned_to : patch.assignedTo},
        recurrence = ${patch.recurrence ?? cur.recurrence},
        completed_at = ${completedAt},
        updated_at = now()
      WHERE id = ${id} AND business_id = ${ctx.businessId}
      RETURNING ${cols(sql)}`;
    let next: Row | null = null;
    if (completing && row.recurrence !== "none") {
      next = await insertTask(sql, ctx, {
        title: row.title,
        description: row.description,
        priority: row.priority,
        dueDate: nextDueDate(row.due_date, row.recurrence, today),
        assignedTo: row.assigned_to,
        source: row.source,
        sourceRef: row.source_ref,
        recurrence: row.recurrence,
        createdBy: row.created_by,
      });
    }
    return { task: row, next };
  });
}

export const tool: ToolDef = {
  id: "tasks",
  name: "Tasks & reminders",
  description: "One task list for everything: yours, and the ones other tools raise.",
  group: "operations",
  status: "live",
  migrations: [
    {
      name: "0001_items",
      sql: `CREATE TABLE tasks_items (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        title        text NOT NULL,
        description  text NOT NULL DEFAULT '',
        status       text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
        priority     text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
        due_date     date,
        assigned_to  text,
        source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','compliance','document','crm','finance','system')),
        source_ref   jsonb,
        recurrence   text NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','weekly','monthly','quarterly','yearly')),
        created_by   text NOT NULL,
        completed_at timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tasks_items_open ON tasks_items (business_id, status, due_date);
      CREATE INDEX tasks_items_source ON tasks_items (business_id, (source_ref->>'tool'), (source_ref->>'id'));`,
    },
  ],

  api: route({
    "GET items": async (ctx, req) => {
      const q = new URL(req.url).searchParams;
      const sql = ctx.sql;
      const where = [sql`business_id = ${ctx.businessId}`];
      const status = q.get("status");
      if (status) {
        if (status === "open") where.push(sql`status <> 'done'`);
        else if ((STATUSES as readonly string[]).includes(status)) where.push(sql`status = ${status}`);
        else throw new HttpError(400, "Unknown status");
      }
      const due = q.get("due");
      if (due) {
        if (due === "overdue") where.push(sql`status <> 'done' AND due_date < current_date`);
        else if (due === "today") where.push(sql`due_date = current_date`);
        else if (due === "week") where.push(sql`due_date BETWEEN current_date AND current_date + 7`);
        else if (due === "upcoming") where.push(sql`due_date > current_date`);
        else if (due === "none") where.push(sql`due_date IS NULL`);
        else throw new HttpError(400, "Unknown due window");
      }
      const from = q.get("dueFrom");
      const to = q.get("dueTo");
      if (from) { if (!isIsoDate(from)) throw new HttpError(400, "dueFrom must be YYYY-MM-DD"); where.push(sql`due_date >= ${from}`); }
      if (to) { if (!isIsoDate(to)) throw new HttpError(400, "dueTo must be YYYY-MM-DD"); where.push(sql`due_date <= ${to}`); }
      const source = q.get("source");
      if (source) {
        if (!(SOURCES as readonly string[]).includes(source)) throw new HttpError(400, "Unknown source");
        where.push(sql`source = ${source}`);
      }
      if (q.get("mine") === "1") where.push(sql`assigned_to = ${ctx.userId}`);
      const st = q.get("sourceTool");
      const sid = q.get("sourceId");
      if (st && sid) where.push(sql`source_ref->>'tool' = ${st} AND source_ref->>'id' = ${sid}`);
      const limit = Math.min(Math.max(Number(q.get("limit")) || 200, 1), 500);
      const cond = where.reduce((a, b) => sql`${a} AND ${b}`);
      const rows = await sql<Row[]>`
        SELECT ${cols(sql)} FROM tasks_items WHERE ${cond}
        ORDER BY due_date ASC NULLS LAST, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT ${limit}`;
      return json({ tasks: rows.map(out) });
    },

    "GET items/:id": async (ctx, _req, p) => {
      const [row] = await ctx.sql<Row[]>`SELECT ${cols(ctx.sql)} FROM tasks_items WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (!row) throw new HttpError(404, "Not found");
      return json({ task: out(row) });
    },

    "POST items": async (ctx, req) => {
      requireWrite(ctx);
      const body = await readJson(req, CreateBody);
      const row = await insertTask(ctx.sql, ctx, body);
      return json({ task: out(row) }, 201);
    },

    "PATCH items/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const body = await readJson(req, UpdateBody);
      const { task, next } = await applyUpdate(ctx, uuidParam(p.id), body);
      return json({ task: out(task), next: next ? out(next) : null });
    },

    "POST items/:id/complete": async (ctx, _req, p) => {
      requireWrite(ctx);
      const { task, next } = await applyUpdate(ctx, uuidParam(p.id), { status: "done" });
      return json({ task: out(task), next: next ? out(next) : null });
    },

    "DELETE items/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const id = uuidParam(p.id);
      const r = await ctx.sql`DELETE FROM tasks_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },

    // Other tools' pages call this from the browser to turn one of their records into a task. We check nothing about the other tool.
    "POST from-source": async (ctx, req) => {
      requireWrite(ctx);
      const body = await readJson(req, { parse: (raw: unknown) => FromSourceBody.parse(normalizeFromSource(raw)) });
      const items = "tasks" in body ? body.tasks : [body];
      const created: ReturnType<typeof out>[] = [];
      let deduped = 0;
      for (const it of items) {
        // The same record asking twice for the same open task gives back the existing one.
        if (it.sourceRef) {
          const [dup] = await ctx.sql<Row[]>`
            SELECT ${cols(ctx.sql)} FROM tasks_items
            WHERE business_id = ${ctx.businessId} AND status <> 'done' AND source = ${it.source} AND title = ${it.title}
              AND source_ref->>'tool' = ${it.sourceRef.tool} AND source_ref->>'id' = ${it.sourceRef.id} LIMIT 1`;
          if (dup) { created.push(out(dup)); deduped++; continue; }
        }
        const row = await insertTask(ctx.sql, ctx, { ...it, sourceRef: it.sourceRef ?? null });
        if (it.sourceRef) {
          try {
            await ctx.links.add({ tool: "tasks", id: row.id }, { tool: it.sourceRef.tool, id: it.sourceRef.id }, "source");
          } catch {
            // The referenced record may not resolve (unknown tool, wrong id): the task is still created.
          }
        }
        created.push(out(row));
      }
      return json({ task: created[0], tasks: created, deduped }, deduped === created.length ? 200 : 201);
    },
  }),

  async Page({ ctx, path }) {
    const rows = await ctx.sql<Row[]>`
      SELECT ${cols(ctx.sql)} FROM tasks_items
      WHERE business_id = ${ctx.businessId} AND (status <> 'done' OR completed_at > now() - interval '30 days')
      ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT 500`;
    const today = await dbToday(ctx.sql);
    const openId = path[0] === "t" && path[1] && UUID_RE.test(path[1]) ? path[1] : undefined;
    return <TasksBoard initial={rows.map(out)} today={today} canWrite={ctx.canWrite} userId={ctx.userId} openId={openId} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const rows = await ctx.sql<{ id: string; title: string; priority: string; due_date: string; overdue: boolean; days: number }[]>`
      SELECT id, title, priority, to_char(due_date, 'YYYY-MM-DD') AS due_date, due_date < current_date AS overdue, (due_date - current_date) AS days
      FROM tasks_items
      WHERE business_id = ${ctx.businessId} AND status <> 'done' AND due_date IS NOT NULL AND due_date <= current_date + 3
      ORDER BY due_date ASC, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 10`;
    return rows.map((r) => ({
      id: `tasks-${r.id}`,
      title: r.title,
      detail: r.overdue ? `Overdue by ${-r.days} day${r.days === -1 ? "" : "s"} (${r.priority} priority)` : r.days === 0 ? `Due today (${r.priority} priority)` : `Due in ${r.days} day${r.days === 1 ? "" : "s"} (${r.priority} priority)`,
      severity: r.overdue ? (r.priority === "high" ? "high" : "review") : r.priority === "high" ? "review" : "info",
      href: `/app/t/tasks/t/${r.id}`,
      dueDate: r.due_date,
    }));
  },

  async facts(ctx) {
    const [r] = await ctx.sql<{ open: number; overdue: number; due_this_week: number; done30: number }[]>`
      SELECT
        count(*) FILTER (WHERE status <> 'done')::int AS open,
        count(*) FILTER (WHERE status <> 'done' AND due_date < current_date)::int AS overdue,
        count(*) FILTER (WHERE status <> 'done' AND due_date BETWEEN current_date AND current_date + 7)::int AS due_this_week,
        count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '30 days')::int AS done30
      FROM tasks_items WHERE business_id = ${ctx.businessId}`;
    return { open: r.open, overdue: r.overdue, dueThisWeek: r.due_this_week, completedLast30Days: r.done30 };
  },

  async describe(ctx) {
    const f = (await tool.facts!(ctx)) as { open: number; overdue: number; dueThisWeek: number; completedLast30Days: number };
    if (f.open === 0 && f.completedLast30Days === 0) return "";
    const top = await ctx.sql<{ title: string }[]>`
      SELECT title FROM tasks_items WHERE business_id = ${ctx.businessId} AND status <> 'done'
      ORDER BY (due_date < current_date) DESC NULLS LAST, due_date ASC NULLS LAST, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 3`;
    const bits = [`${f.open} open task${f.open === 1 ? "" : "s"}, ${f.overdue} overdue, ${f.dueThisWeek} due in the next 7 days; ${f.completedLast30Days} completed in the last 30 days.`];
    if (top.length) bits.push(`Most pressing: ${top.map((t) => `"${t.title.slice(0, 60)}"`).join(", ")}.`);
    return bits.join(" ").slice(0, 600);
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ title: string }[]>`SELECT title FROM tasks_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.title, href: `/app/t/tasks/t/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const stripped = query.replace(/[\\%_]/g, "").trim();
    if (!stripped) return [];
    const like = "%" + stripped + "%";
    const rows = await ctx.sql<{ id: string; title: string; status: string; due_date: string | null }[]>`
      SELECT id, title, status, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM tasks_items
      WHERE business_id = ${ctx.businessId} AND (title ILIKE ${like} OR description ILIKE ${like})
      ORDER BY (status = 'done'), due_date ASC NULLS LAST LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: r.status === "done" ? "done" : r.due_date ? `due ${r.due_date}` : "no due date", href: `/app/t/tasks/t/${r.id}` }));
  },
};
