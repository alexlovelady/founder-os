import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type Sql, type ToolContext, type ToolDef } from "@founderos/sdk";
import { CATEGORIES, keyDocumentFlags, normalizeDocType } from "./facts";
import { attachmentHeader, FileRejected, MAX_BYTES, safeContentType, sanitizeFilename, validateFile } from "./files";
import VaultLibrary from "./ui/VaultLibrary";
import VaultDetail from "./ui/VaultDetail";

const STATUSES = ["active", "draft", "review", "archived"] as const;
const SOON_DAYS = 60;

const isDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const dateStr = z.string().refine(isDate, "Use a date like 2026-12-31");
const category = z.enum(CATEGORIES);
const docType = z.string().trim().max(100);
const name = z.string().trim().min(1, "Name is required").max(200);
const tags = z.array(z.string().trim().min(1).max(40)).max(20);

function normTags(list: string[]): string[] {
  return [...new Set(list.map((t) => t.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean))];
}

const UpdateBody = z
  .object({ name: name.optional(), category: category.optional(), docType: docType.optional(), tags: tags.optional(), status: z.enum(STATUSES).optional(), expirationDate: dateStr.nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");

interface DocRow {
  id: string;
  name: string;
  original_filename: string;
  category: string;
  doc_type: string;
  tags: string[];
  status: (typeof STATUSES)[number];
  expiration_date: string | null;
  days_left: number | null;
  version: number;
  sha256: string;
  size: number;
  content_type: string;
  uploaded_by: string;
  created_at: Date;
  updated_at: Date;
}

const cols = (sql: Sql) => sql`id, name, original_filename, category, doc_type, tags, status, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date,
  (expiration_date - current_date) AS days_left, version, sha256, size::int AS size, content_type, uploaded_by, created_at, updated_at`;

const out = (r: DocRow) => ({
  id: r.id,
  name: r.name,
  originalFilename: r.original_filename,
  category: r.category,
  docType: r.doc_type,
  tags: r.tags,
  status: r.status,
  expirationDate: r.expiration_date,
  daysLeft: r.days_left,
  version: r.version,
  sha256: r.sha256,
  size: r.size,
  contentType: r.content_type,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

interface VersionRow { version: number; original_filename: string; content_type: string; size: number; sha256: string; uploaded_by: string; created_at: Date }
const versionOut = (v: VersionRow, current: number) => ({
  version: v.version, originalFilename: v.original_filename, contentType: v.content_type, size: v.size, sha256: v.sha256, uploadedBy: v.uploaded_by, createdAt: v.created_at.toISOString(), isCurrent: v.version === current,
});

async function loadDetail(ctx: ToolContext, id: string) {
  const [doc] = await ctx.sql<DocRow[]>`SELECT ${cols(ctx.sql)} FROM vault_documents WHERE id = ${id} AND business_id = ${ctx.businessId}`;
  if (!doc) return null;
  const versions = await ctx.sql<VersionRow[]>`
    SELECT version, original_filename, content_type, size::int AS size, sha256, uploaded_by, created_at FROM vault_versions
    WHERE document_id = ${id} AND business_id = ${ctx.businessId} ORDER BY version DESC`;
  return { document: out(doc), versions: versions.map((v) => versionOut(v, doc.version)) };
}

/** Read the uploaded file out of a multipart request and check it. Throws HttpError with a clear message. */
async function readUpload(req: Request): Promise<{ form: FormData; filename: string; ext: string; bytes: Buffer }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES + 1024 * 1024) throw new HttpError(413, "The file is larger than the 15 MB limit.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Expected a multipart form upload with a \"file\" field");
  }
  const f = form.get("file");
  if (!f || typeof f === "string") throw new HttpError(400, "Choose a file to upload");
  if (f.size > MAX_BYTES) throw new HttpError(413, "The file is larger than the 15 MB limit.");
  const bytes = Buffer.from(await f.arrayBuffer());
  const filename = sanitizeFilename(f.name);
  try {
    const ext = validateFile(filename, bytes);
    return { form, filename, ext, bytes };
  } catch (e) {
    if (e instanceof FileRejected) throw new HttpError(e.message.includes("15 MB") ? 413 : 415, e.message);
    throw e;
  }
}

const field = (form: FormData, k: string): string | undefined => {
  const v = form.get(k);
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
};

const UploadFields = z.object({
  name: name.optional(),
  category: category.optional(),
  docType: docType.optional(),
  status: z.enum(STATUSES).optional(),
  expirationDate: dateStr.optional(),
  tags: tags.optional(),
});

function parseUploadFields(form: FormData) {
  let tagList: string[] | undefined;
  const rawTags = field(form, "tags");
  if (rawTags) {
    try {
      const parsed = JSON.parse(rawTags);
      tagList = Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
      tagList = rawTags.split(",");
    }
  }
  const input = { name: field(form, "name"), category: field(form, "category"), docType: field(form, "docType"), status: field(form, "status"), expirationDate: field(form, "expirationDate"), tags: tagList?.map((t) => String(t)) };
  const r = UploadFields.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `${i?.path.join(".") || "input"}: ${i?.message}`);
  }
  return r.data;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function storeBlob(sql: Sql, ctx: ToolContext, documentId: string, bytes: Buffer): Promise<string> {
  const blobId = randomUUID(); // internal storage name; the user's filename is never used for storage
  await sql`INSERT INTO vault_blobs (id, business_id, document_id, data) VALUES (${blobId}, ${ctx.businessId}, ${documentId}, ${bytes})`;
  return blobId;
}

export const tool: ToolDef = {
  id: "vault",
  name: "Document vault",
  description: "Your business's organized file cabinet: contracts, formation records, policies, insurance and tax papers, with expiry reminders.",
  group: "business",
  status: "live",
  migrations: [
    {
      name: "0001_documents",
      sql: `CREATE TABLE vault_documents (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name              text NOT NULL,
        original_filename text NOT NULL,
        category          text NOT NULL DEFAULT 'Other',
        doc_type          text NOT NULL DEFAULT '',
        tags              text[] NOT NULL DEFAULT '{}',
        status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','review','archived')),
        expiration_date   date,
        version           int NOT NULL DEFAULT 1,
        sha256            text NOT NULL,
        size              bigint NOT NULL,
        content_type      text NOT NULL,
        uploaded_by       text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX vault_documents_business ON vault_documents (business_id, category, status);
      CREATE INDEX vault_documents_expiry ON vault_documents (business_id, expiration_date) WHERE expiration_date IS NOT NULL;
      CREATE TABLE vault_blobs (
        id          uuid PRIMARY KEY,
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
        data        bytea NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX vault_blobs_document ON vault_blobs (document_id);
      CREATE TABLE vault_versions (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        document_id       uuid NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
        blob_id           uuid NOT NULL REFERENCES vault_blobs(id) ON DELETE CASCADE,
        version           int NOT NULL,
        original_filename text NOT NULL,
        content_type      text NOT NULL,
        size              bigint NOT NULL,
        sha256            text NOT NULL,
        uploaded_by       text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (document_id, version)
      );`,
    },
  ],

  api: route({
    "GET documents": async (ctx, req) => {
      const q = new URL(req.url).searchParams;
      const sql = ctx.sql;
      const where = [sql`business_id = ${ctx.businessId}`];
      const cat = q.get("category");
      if (cat) {
        if (!(CATEGORIES as readonly string[]).includes(cat)) throw new HttpError(400, "Unknown category");
        where.push(sql`category = ${cat}`);
      }
      const status = q.get("status");
      if (status === "all") {
        // everything, including archived
      } else if (status) {
        if (!(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "Unknown status");
        where.push(sql`status = ${status}`);
      } else {
        where.push(sql`status <> 'archived'`);
      }
      if (q.get("expiring") === "1") where.push(sql`expiration_date IS NOT NULL AND expiration_date <= current_date + ${SOON_DAYS}::int AND status <> 'archived'`);
      const tag = q.get("tag");
      if (tag) where.push(sql`${tag.toLowerCase()} = ANY(tags)`);
      const text = (q.get("q") ?? "").trim().slice(0, 100);
      if (text) {
        const stripped = text.replace(/[\\%_]/g, "");
        const like = "%" + stripped + "%";
        if (!stripped) where.push(sql`false`);
        else where.push(sql`(name ILIKE ${like} OR original_filename ILIKE ${like} OR doc_type ILIKE ${like} OR category ILIKE ${like} OR array_to_string(tags, ' ') ILIKE ${like}
          OR to_tsvector('simple', name || ' ' || doc_type || ' ' || array_to_string(tags, ' ')) @@ plainto_tsquery('simple', ${text}))`);
      }
      const cond = where.reduce((a, b) => sql`${a} AND ${b}`);
      const rows = await sql<DocRow[]>`SELECT ${cols(sql)} FROM vault_documents WHERE ${cond} ORDER BY updated_at DESC LIMIT 500`;
      const counts = await sql<{ category: string; n: number }[]>`
        SELECT category, count(*)::int AS n FROM vault_documents WHERE business_id = ${ctx.businessId} AND status <> 'archived' GROUP BY category`;
      return json({ documents: rows.map(out), categories: counts.map((c) => ({ category: c.category, count: c.n })) });
    },

    "GET documents/:id": async (ctx, _req, p) => {
      const d = await loadDetail(ctx, uuidParam(p.id));
      if (!d) throw new HttpError(404, "Not found");
      return json(d);
    },

    "POST documents": async (ctx, req) => {
      requireWrite(ctx);
      const { form, filename, bytes } = await readUpload(req);
      const f = parseUploadFields(form);
      const dot = filename.lastIndexOf(".");
      const display = f.name ?? (dot > 0 ? filename.slice(0, dot) : filename);
      const id = randomUUID();
      const digest = sha(bytes);
      const ext = filename.slice(dot + 1).toLowerCase();
      await ctx.sql.begin(async (tx) => {
        const sql = tx as unknown as Sql;
        await sql`
          INSERT INTO vault_documents (id, business_id, name, original_filename, category, doc_type, tags, status, expiration_date, version, sha256, size, content_type, uploaded_by)
          VALUES (${id}, ${ctx.businessId}, ${display.slice(0, 200)}, ${filename}, ${f.category ?? "Other"}, ${f.docType ?? ""}, ${normTags(f.tags ?? [])}, ${f.status ?? "active"}, ${f.expirationDate ?? null}, 1,
                  ${digest}, ${bytes.length}, ${safeContentType(ext)}, ${ctx.userId})`;
        const blobId = await storeBlob(sql, ctx, id, bytes);
        await sql`
          INSERT INTO vault_versions (business_id, document_id, blob_id, version, original_filename, content_type, size, sha256, uploaded_by)
          VALUES (${ctx.businessId}, ${id}, ${blobId}, 1, ${filename}, ${safeContentType(ext)}, ${bytes.length}, ${digest}, ${ctx.userId})`;
      });
      return json(await loadDetail(ctx, id), 201);
    },

    "PATCH documents/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const id = uuidParam(p.id);
      const b = await readJson(req, UpdateBody);
      const [cur] = await ctx.sql<DocRow[]>`SELECT ${cols(ctx.sql)} FROM vault_documents WHERE id = ${id} AND business_id = ${ctx.businessId}`;
      if (!cur) throw new HttpError(404, "Not found");
      const [row] = await ctx.sql<DocRow[]>`
        UPDATE vault_documents SET
          name = ${b.name ?? cur.name}, category = ${b.category ?? cur.category}, doc_type = ${b.docType ?? cur.doc_type},
          tags = ${b.tags ? normTags(b.tags) : cur.tags}, status = ${b.status ?? cur.status},
          expiration_date = ${b.expirationDate === undefined ? cur.expiration_date : b.expirationDate}, updated_at = now()
        WHERE id = ${id} AND business_id = ${ctx.businessId} RETURNING ${cols(ctx.sql)}`;
      return json({ document: out(row) });
    },

    "DELETE documents/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM vault_documents WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },

    "POST documents/:id/versions": async (ctx, req, p) => {
      requireWrite(ctx);
      const id = uuidParam(p.id);
      const { filename, bytes } = await readUpload(req);
      const digest = sha(bytes);
      const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
      const ok = await ctx.sql.begin(async (tx) => {
        const sql = tx as unknown as Sql;
        const [doc] = await sql<{ version: number }[]>`SELECT version FROM vault_documents WHERE id = ${id} AND business_id = ${ctx.businessId} FOR UPDATE`;
        if (!doc) return false;
        const v = doc.version + 1;
        const blobId = await storeBlob(sql, ctx, id, bytes);
        await sql`
          INSERT INTO vault_versions (business_id, document_id, blob_id, version, original_filename, content_type, size, sha256, uploaded_by)
          VALUES (${ctx.businessId}, ${id}, ${blobId}, ${v}, ${filename}, ${safeContentType(ext)}, ${bytes.length}, ${digest}, ${ctx.userId})`;
        await sql`
          UPDATE vault_documents SET version = ${v}, original_filename = ${filename}, content_type = ${safeContentType(ext)}, size = ${bytes.length}, sha256 = ${digest}, uploaded_by = ${ctx.userId}, updated_at = now()
          WHERE id = ${id} AND business_id = ${ctx.businessId}`;
        return true;
      });
      if (!ok) throw new HttpError(404, "Not found");
      return json(await loadDetail(ctx, id), 201);
    },

    "GET documents/:id/download": async (ctx, req, p) => {
      const id = uuidParam(p.id);
      const vParam = new URL(req.url).searchParams.get("version");
      if (vParam !== null && !/^\d{1,6}$/.test(vParam)) throw new HttpError(400, "Invalid version");
      // Every join is scoped by business: a blob is never served without ctx.businessId matching.
      const [row] = await ctx.sql<{ original_filename: string; content_type: string; data: Buffer }[]>`
        SELECT v.original_filename, v.content_type, b.data
        FROM vault_documents d
        JOIN vault_versions v ON v.document_id = d.id AND v.business_id = d.business_id AND v.version = ${vParam === null ? ctx.sql`d.version` : Number(vParam)}
        JOIN vault_blobs b ON b.id = v.blob_id AND b.business_id = d.business_id
        WHERE d.id = ${id} AND d.business_id = ${ctx.businessId}`;
      if (!row) throw new HttpError(404, "Not found");
      const ext = row.original_filename.slice(row.original_filename.lastIndexOf(".") + 1).toLowerCase();
      return new Response(new Uint8Array(row.data), {
        status: 200,
        headers: {
          "Content-Type": safeContentType(ext),
          "Content-Disposition": attachmentHeader(row.original_filename),
          "Content-Length": String(row.data.length),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "private, no-store",
        },
      });
    },
  }),

  async Page({ ctx, path }) {
    if (path[0] === "d" && path[1] && UUID_RE.test(path[1])) {
      const d = await loadDetail(ctx, path[1]);
      if (d) return <VaultDetail initial={d} canWrite={ctx.canWrite} />;
    }
    const rows = await ctx.sql<DocRow[]>`SELECT ${cols(ctx.sql)} FROM vault_documents WHERE business_id = ${ctx.businessId} AND status <> 'archived' ORDER BY updated_at DESC LIMIT 500`;
    return <VaultLibrary initial={rows.map(out)} canWrite={ctx.canWrite} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const rows = await ctx.sql<{ id: string; name: string; expiration_date: string; days: number }[]>`
      SELECT id, name, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date, (expiration_date - current_date) AS days
      FROM vault_documents
      WHERE business_id = ${ctx.businessId} AND status <> 'archived' AND expiration_date IS NOT NULL AND expiration_date <= current_date + ${SOON_DAYS}::int
      ORDER BY expiration_date ASC LIMIT 10`;
    return rows.map((r) => ({
      id: `vault-expiry-${r.id}`,
      title: r.days < 0 ? `${r.name} has expired` : `${r.name} expires soon`,
      detail: r.days < 0 ? `Expired ${-r.days} day${r.days === -1 ? "" : "s"} ago (${r.expiration_date}). Renew it or archive it.` : `Expires in ${r.days} day${r.days === 1 ? "" : "s"} (${r.expiration_date}).`,
      severity: r.days < 0 ? "high" : r.days <= 30 ? "review" : "info",
      href: `/app/t/vault/d/${r.id}`,
      dueDate: r.expiration_date,
    }));
  },

  async facts(ctx) {
    const rows = await ctx.sql<{ name: string; doc_type: string; category: string; status: string; expired: boolean; soon: boolean }[]>`
      SELECT name, doc_type, category, status, (expiration_date < current_date) AS expired, (expiration_date <= current_date + ${SOON_DAYS}::int) AS soon
      FROM vault_documents WHERE business_id = ${ctx.businessId} AND status <> 'archived' LIMIT 5000`;
    // Drafts do not count as "having" a key document; everything else non-archived does.
    const flags = keyDocumentFlags(rows.filter((r) => r.status !== "draft"));
    return {
      documentCount: rows.length,
      categories: [...new Set(rows.map((r) => r.category.toLowerCase()))].sort(),
      docTypes: [...new Set(rows.map((r) => normalizeDocType(r.doc_type)).filter(Boolean))].sort(),
      expiringSoon: rows.filter((r) => r.soon).length,
      expired: rows.filter((r) => r.expired).length,
      ...flags,
    };
  },

  async describe(ctx) {
    const f = (await tool.facts!(ctx)) as { documentCount: number; expiringSoon: number; expired: number } & ReturnType<typeof keyDocumentFlags>;
    if (f.documentCount === 0) return "";
    const cats = await ctx.sql<{ category: string; n: number }[]>`
      SELECT category, count(*)::int AS n FROM vault_documents WHERE business_id = ${ctx.businessId} AND status <> 'archived' GROUP BY category ORDER BY n DESC, category LIMIT 8`;
    const have: string[] = [];
    const missing: string[] = [];
    const key: [boolean, string][] = [[f.hasOperatingAgreement, "operating agreement"], [f.hasPrivacyPolicy, "privacy policy"], [f.hasContractorAgreement, "contractor agreement"], [f.hasInsurance, "insurance"], [f.hasFormationDocs, "formation records"]];
    for (const [ok, label] of key) (ok ? have : missing).push(label);
    const parts = [`${f.documentCount} document${f.documentCount === 1 ? "" : "s"} on file (${cats.map((c) => `${c.category} ${c.n}`).join(", ")}).`];
    if (have.length) parts.push(`Found: ${have.join(", ")}.`);
    if (missing.length) parts.push(`Not found by name or type: ${missing.join(", ")}.`);
    if (f.expiringSoon) parts.push(`${f.expiringSoon} expiring within ${SOON_DAYS} days${f.expired ? ` (${f.expired} already expired)` : ""}.`);
    return parts.join(" ").slice(0, 600);
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ name: string }[]>`SELECT name FROM vault_documents WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.name, href: `/app/t/vault/d/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const stripped = query.replace(/[\\%_]/g, "").trim();
    if (!stripped) return [];
    const like = "%" + stripped + "%";
    const rows = await ctx.sql<{ id: string; name: string; category: string; doc_type: string }[]>`
      SELECT id, name, category, doc_type FROM vault_documents
      WHERE business_id = ${ctx.businessId} AND (name ILIKE ${like} OR original_filename ILIKE ${like} OR doc_type ILIKE ${like} OR category ILIKE ${like} OR array_to_string(tags, ' ') ILIKE ${like})
      ORDER BY (status = 'archived'), updated_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.name, snippet: r.doc_type ? `${r.category} · ${r.doc_type}` : r.category, href: `/app/t/vault/d/${r.id}` }));
  },
};
