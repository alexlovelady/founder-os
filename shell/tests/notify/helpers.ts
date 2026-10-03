import type { AttentionItem, ToolDef } from "@founderos/sdk";

/** A stand-in tool with scripted attention() and describe() output, so tests never depend on a real tool's tables. */
export const scripted = (items: AttentionItem[], describe = "", id = "tasks", name = "Tasks"): ToolDef => ({
  id,
  name,
  description: "",
  group: "operations",
  status: "live",
  attention: async () => items,
  describe: async () => describe,
});

export const NOW = new Date("2026-10-07T12:00:00Z"); // a Wednesday; the week starts 2026-10-05
