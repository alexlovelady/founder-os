/**
 * Hand-off from a vault document to LegalAI for legal review (spec 14).
 *
 * How the bytes get here: the shell never imports vault internals. It calls the vault tool's own `api` handler (the same one the browser uses
 * for downloads) with the signed-in user's tenant-scoped context, so access control, business scoping and the vault's file rules all apply.
 * Then it talks to LegalAI server-to-server with the user's cookie and CSRF token, exactly like shell/src/lib/legal.ts:
 *   POST /api/documents (multipart matter_id + file)  ->  wait until LegalAI has parsed it  ->  POST /api/contracts/review.
 * The link (LegalAI document id and review id) is stored back in the vault through its `POST documents/:id/legal-link` route.
 * Document contents are never logged, and nothing here is cached.
 *
 * No Next.js imports on purpose: the route is a thin wrapper, and this logic is tested with an injected fetch.
 */
import type { ToolContext, ToolDef } from "@founderos/sdk";

export const PERSPECTIVES = ["neutral", "customer", "vendor", "employer", "employee"] as const;
export type Perspective = (typeof PERSPECTIVES)[number];

export const LEGAL_UI_URL = "/legal-ui/";
const UUID_LOOSE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a contract review lives in the LegalAI UI (served by the shell under /legal-ui): the Contracts tab of the company workspace
 * (route /matters/:id/contracts in modules/legal/web/src/App.tsx + MatterPage.tsx), with `?review=<id>` opening that review.
 * Falls back to the LegalAI home when the workspace id is unknown. Ids are validated so nothing odd lands in the URL.
 */
export function legalReviewUrl(workspaceId: string | null | undefined, reviewId?: string | null): string {
  if (!workspaceId || !UUID_LOOSE.test(workspaceId)) return LEGAL_UI_URL;
  const base = `${LEGAL_UI_URL}matters/${workspaceId.toLowerCase()}/contracts`;
  return reviewId && UUID_LOOSE.test(reviewId) ? `${base}?review=${reviewId.toLowerCase()}` : base;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BridgeInput {
  ctx: ToolContext;
  /** The vault tool (looked up from the registry by the route). */
  tool: ToolDef;
  documentId: string;
  perspective: string;
  /** business.modules.legal.workspaceId: the LegalAI company workspace that will hold the document. */
  workspaceId: string | undefined;
  session: { cookie: string; csrf: string };
}

export interface BridgeDeps {
  fetch?: typeof fetch;
  legalUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** How many times to check whether LegalAI has finished reading the upload, and how long to wait between checks. */
  parseChecks?: number;
  parseIntervalMs?: number;
}

export interface BridgeResult {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string): BridgeResult => ({ status, body: { error } });

class Stop extends Error {
  constructor(public result: BridgeResult) {
    super(result.body.error as string);
  }
}

function mapLegalError(status: number, detail: unknown, what: "upload" | "review" | "read"): BridgeResult {
  const d = typeof detail === "string" ? detail.slice(0, 200) : "";
  switch (status) {
    case 401:
      return fail(401, "Your LegalAI session has expired. Sign in again, then retry.");
    case 403:
      return fail(403, "Your account does not have permission to add documents to this business's LegalAI workspace.");
    case 404:
      return fail(409, "LegalAI could not find this business's workspace or document. Open the dashboard so it can be set up again.");
    case 413:
      return fail(413, "LegalAI refused the file because it is too large.");
    case 422:
      return fail(422, `LegalAI could not accept this file${d ? `: ${d}` : "."}`);
    case 429:
      return fail(429, "LegalAI is busy right now. Try again in a minute.");
    default:
      return fail(502, `LegalAI had a problem ${what === "upload" ? "receiving the file" : what === "review" ? "starting the review" : "checking the document"} (error ${status}). Try again shortly.`);
  }
}

function filenameFrom(disposition: string | null): string {
  if (!disposition) return "document";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      /* fall through to the plain filename */
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? "document";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Send one vault document to LegalAI and start a contract review. Never throws: failures come back as { status, body: { error } }. */
export async function reviewInLegal(input: BridgeInput, deps: BridgeDeps = {}): Promise<BridgeResult> {
  const { ctx, tool, documentId, session } = input;
  const doFetch = deps.fetch ?? fetch;
  const base = deps.legalUrl ?? process.env.LEGAL_URL ?? "http://localhost:8000";
  const sleep = deps.sleep ?? defaultSleep;
  const checks = deps.parseChecks ?? 15;
  const interval = deps.parseIntervalMs ?? 2000;

  // Viewers can read documents but must not push them out to another system.
  if (!ctx.canWrite) return fail(403, "Your role cannot send documents to LegalAI.");
  if (!UUID_RE.test(documentId)) return fail(404, "Document not found.");
  if (!(PERSPECTIVES as readonly string[]).includes(input.perspective)) return fail(400, "Choose which side you are on: customer, vendor, employer, employee or neutral.");
  const perspective = input.perspective as Perspective;
  if (!input.workspaceId) return fail(409, "LegalAI is not set up for this business yet. Open the dashboard to finish setup.");
  if (!tool.api) return fail(404, "The document vault is not available.");
  const workspaceId = input.workspaceId;

  const legal = async (path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> => {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { cookie: session.cookie, ...(init.headers as Record<string, string> | undefined) };
    if (method !== "GET") headers["x-csrf-token"] = session.csrf;
    try {
      return await doFetch(`${base}${path}`, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new Stop(fail(502, "LegalAI could not be reached. Try again in a minute."));
    }
  };
  const vault = (method: string, path: string, body?: unknown) =>
    tool.api!(ctx, new Request(`http://internal/api/tools/vault/${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), path.split("/"));
  const detailOf = async (r: Response) => ((await r.json().catch(() => null)) as { detail?: unknown } | null)?.detail;

  try {
    // 1. What the vault holds: current version and any earlier hand-off (so a retry does not upload the same file twice).
    const infoRes = await vault("GET", `documents/${documentId}`);
    if (!infoRes.ok) return fail(infoRes.status === 404 ? 404 : 502, infoRes.status === 404 ? "Document not found." : "The vault could not load this document.");
    const info = (await infoRes.json()) as { document: { version: number }; legalLink: { legalDocumentId: string; version: number } | null };
    const version = info.document.version;
    let legalDocumentId: string | null = info.legalLink && info.legalLink.version === version ? info.legalLink.legalDocumentId : null;

    // 2. Wait for LegalAI to finish reading a document it already has.
    const waitParsed = async (id: string): Promise<"parsed" | "pending" | "gone"> => {
      for (let i = 0; i < checks; i++) {
        const r = await legal(`/api/documents/${id}`);
        if (r.status === 404) return "gone";
        if (!r.ok) throw new Stop(mapLegalError(r.status, await detailOf(r), "read"));
        const d = (await r.json()) as { current_version?: { parse_status?: string; parse_error?: string | null } | null };
        const ps = d.current_version?.parse_status;
        if (ps === "parsed") return "parsed";
        if (ps === "failed") throw new Stop(fail(422, "LegalAI could not read this file, so it cannot be reviewed. If it is a scan, make sure it is a clear PDF or image."));
        if (i < checks - 1) await sleep(interval);
      }
      return "pending";
    };

    let state: "parsed" | "pending" | "gone" = "gone";
    if (legalDocumentId) state = await waitParsed(legalDocumentId);

    // 3. Upload when LegalAI does not have this version yet.
    if (state === "gone") {
      const fileRes = await vault("GET", `documents/${documentId}/download`);
      if (!fileRes.ok) return fail(fileRes.status === 404 ? 404 : 502, fileRes.status === 404 ? "Document not found." : "The vault could not read this file.");
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      const filename = filenameFrom(fileRes.headers.get("content-disposition"));
      const fd = new FormData();
      fd.set("matter_id", workspaceId);
      fd.set("file", new Blob([bytes], { type: fileRes.headers.get("content-type") ?? "application/octet-stream" }), filename);
      const up = await legal("/api/documents", { method: "POST", body: fd }, 90_000);
      if (!up.ok) return mapLegalError(up.status, await detailOf(up), "upload");
      const created = (await up.json()) as { id?: string };
      if (!created.id || !UUID_RE.test(created.id)) return fail(502, "LegalAI returned an unexpected answer when receiving the file.");
      legalDocumentId = created.id;
      state = await waitParsed(legalDocumentId);
    }

    const saveLink = async (reviewId: string | null) => {
      const r = await vault("POST", `documents/${documentId}/legal-link`, { legalDocumentId, legalReviewId: reviewId, legalWorkspaceId: UUID_RE.test(workspaceId) ? workspaceId : null, perspective, version });
      return r.ok;
    };

    // LegalAI is still reading it: remember the upload so the next try goes straight to the review.
    if (state !== "parsed") {
      await saveLink(null);
      return { status: 202, body: { state: "processing", legalDocumentId, workspaceId, openUrl: legalReviewUrl(workspaceId), message: "LegalAI is still reading the file. Try the review again in a minute." } };
    }

    // 4. Start the review. This is the costly AI step, so it is counted against the plan first.
    try {
      await ctx.useQuota("ai_request");
    } catch (e) {
      const s = (e as { status?: unknown }).status;
      return fail(typeof s === "number" ? s : 402, e instanceof Error && e.message ? e.message : "Your plan's AI limit has been reached.");
    }
    const rv = await legal("/api/contracts/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document_id: legalDocumentId, perspective }) });
    if (rv.status === 409) {
      await saveLink(null);
      return { status: 202, body: { state: "processing", legalDocumentId, workspaceId, openUrl: legalReviewUrl(workspaceId), message: "LegalAI is still reading the file. Try the review again in a minute." } };
    }
    if (!rv.ok) return mapLegalError(rv.status, await detailOf(rv), "review");
    const review = (await rv.json()) as { id?: string };
    if (!review.id || !UUID_RE.test(review.id)) return fail(502, "LegalAI returned an unexpected answer when starting the review.");

    const linkSaved = await saveLink(review.id);
    await ctx.audit("vault.legal_review_started", { perspective }, { tool: "vault", id: documentId }).catch(() => undefined);
    return { status: 201, body: { state: "started", legalDocumentId, reviewId: review.id, workspaceId, perspective, openUrl: legalReviewUrl(workspaceId, review.id), linkSaved } };
  } catch (e) {
    if (e instanceof Stop) return e.result;
    return fail(500, "Something went wrong sending the document to LegalAI.");
  }
}
