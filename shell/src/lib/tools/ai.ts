import type { AiClient, AiRequest, AiStatus } from "@founderos/sdk";
import type { Session } from "../auth/server";
import { usageFromJob, type AiUsage } from "../metering/tokens";

const LEGAL = process.env.LEGAL_URL ?? "http://localhost:8000";

const clean = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

/**
 * AI for tools. Today it runs on the LegalAI service job queue (and so on the owner's private GPU); the business's LegalAI workspace
 * carries the privacy settings. Replace this one file to route AI elsewhere (cloud models, a customer-supplied key) per plan.
 */
export function makeAiClient(session: Session, workspaceId: string | undefined, onUsage?: (u: AiUsage) => void | Promise<void>): AiClient {
  const call = (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { cookie: session.cookie, ...(init.headers as Record<string, string>) };
    // Tells LegalAI the shell already counts this request against the plan (ctx.useQuota), so it is not counted a second time there.
    const internal = (process.env.INTERNAL_PROVISION_TOKEN ?? "").trim();
    if (method === "POST" && path === "/api/inference" && internal.length >= 32) headers["x-internal-token"] = internal;
    if (method !== "GET") headers["x-csrf-token"] = session.csrf;
    return fetch(`${LEGAL}${path}`, { ...init, headers, cache: "no-store" });
  };
  return {
    available: Boolean(workspaceId),
    async start(req: AiRequest) {
      if (!workspaceId) throw new Error("AI is not set up for this business yet");
      const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }];
      const r = await call("/api/inference", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matter_id: workspaceId, messages, role: req.tier ?? "fast", task: "tool" }),
      });
      if (!r.ok) throw new Error("The AI service could not take this request");
      return { jobId: (await r.json()).id as string };
    },
    async poll(jobId: string): Promise<AiStatus> {
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return { state: "failed", error: "Unknown request" };
      const r = await call(`/api/jobs/${jobId}`);
      if (!r.ok) return { state: "failed", error: "Unknown request" };
      const j = await r.json();
      if (j.state === "COMPLETE") {
        // Token counts are reported once per job (the receiver dedupes on the job id); a failure here never fails the tool.
        if (onUsage) await Promise.resolve(onUsage(usageFromJob(jobId, j))).catch(() => undefined);
        return { state: "done", text: clean(String(j.result?.content ?? "")) };
      }
      if (j.state === "FAILED" || j.state === "CANCELED") return { state: "failed", error: j.error || "The AI request did not finish" };
      if (j.state === "WAITING_FOR_GPU") return { state: "waiting", message: "Your private AI computer is offline. This will finish when it is back on." };
      return { state: "running" };
    },
  };
}
