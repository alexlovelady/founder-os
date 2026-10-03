/**
 * Actions the Ask FounderOS assistant may propose for tasks. A person confirms each one; the model never runs them.
 * Every action goes through the tool's own API handler, so its validation and business rules (recurrence, completed_at, ...) apply unchanged.
 */
import { z } from "zod";
import { callToolApi, clipText, requireWrite, UUID_RE, type ToolAction, type ToolContext, type ToolDef } from "@founderos/sdk";
import { isIsoDate } from "./dates";

const dateStr = z.string().refine(isIsoDate, "Use a date like 2026-12-31");
const taskId = z.string().regex(UUID_RE, "Not a valid id");

interface TaskDto { id: string; title: string; status: string; priority: string; dueDate: string | null; recurrence: string }

export function tasksActions(self: () => ToolDef): ToolAction[] {
  const getTask = async (ctx: ToolContext, id: string) => (await callToolApi<{ task: TaskDto }>(self(), ctx, "GET", `items/${id}`)).task;
  const href = (id: string) => `/app/t/tasks/t/${id}`;

  const CreateInput = z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    dueDate: dateStr.optional(),
  });
  const create: ToolAction<z.infer<typeof CreateInput>> = {
    id: "create_task",
    description: "Create a new task (optionally with a due date and priority).",
    input: CreateInput,
    risk: "low",
    async preview(_ctx, i) {
      return {
        summary: `Create the task "${clipText(i.title, 120)}"${i.dueDate ? ` due ${i.dueDate}` : ""}.`,
        details: { Title: i.title, ...(i.dueDate ? { Due: i.dueDate } : {}), Priority: i.priority ?? "medium", ...(i.description ? { Notes: clipText(i.description, 300) } : {}) },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = CreateInput.parse(i);
      // With a key, the same proposal asking twice gives back the first task (tasks dedupes on source + title + sourceRef).
      const r = await callToolApi<{ task: TaskDto }>(self(), ctx, "POST", "from-source", {
        title: v.title, description: v.description, priority: v.priority, dueDate: v.dueDate ?? null,
        source: "ai", ...(ctx.idempotencyKey ? { sourceRef: { tool: "founderai", id: ctx.idempotencyKey } } : {}),
      });
      return { summary: `Created the task "${clipText(r.task.title, 120)}".`, href: href(r.task.id) };
    },
  };

  const CompleteInput = z.object({ taskId });
  const complete: ToolAction<z.infer<typeof CompleteInput>> = {
    id: "complete_task",
    description: "Mark an existing task as done (a repeating task creates its next occurrence).",
    input: CompleteInput,
    risk: "low",
    async preview(ctx, i) {
      const t = await getTask(ctx, i.taskId);
      if (t.status === "done") return { summary: `"${clipText(t.title, 120)}" is already done; nothing would change.`, details: { Task: t.title } };
      return {
        summary: `Mark "${clipText(t.title, 120)}" as done.`,
        details: { Task: t.title, "Now": t.status.replace("_", " "), ...(t.recurrence !== "none" ? { Repeats: `${t.recurrence}; the next one is created` } : {}) },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = CompleteInput.parse(i);
      const r = await callToolApi<{ task: TaskDto }>(self(), ctx, "POST", `items/${v.taskId}/complete`);
      return { summary: `Marked "${clipText(r.task.title, 120)}" as done.`, href: href(r.task.id) };
    },
  };

  const RescheduleInput = z.object({ taskId, dueDate: dateStr });
  const reschedule: ToolAction<z.infer<typeof RescheduleInput>> = {
    id: "reschedule_task",
    description: "Change the due date of an existing task.",
    input: RescheduleInput,
    risk: "low",
    async preview(ctx, i) {
      const t = await getTask(ctx, i.taskId);
      return {
        summary: `Move "${clipText(t.title, 120)}" from ${t.dueDate ?? "no due date"} to ${i.dueDate}.`,
        details: { Task: t.title, "Old due date": t.dueDate ?? "none", "New due date": i.dueDate },
      };
    },
    async run(ctx, i) {
      requireWrite(ctx);
      const v = RescheduleInput.parse(i);
      const r = await callToolApi<{ task: TaskDto }>(self(), ctx, "PATCH", `items/${v.taskId}`, { dueDate: v.dueDate });
      return { summary: `"${clipText(r.task.title, 120)}" is now due ${r.task.dueDate}.`, href: href(r.task.id) };
    },
  };

  return [create, complete, reschedule];
}
