import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { analyze, declaredLicense, detectLicenseText, diffScans, parseDependencies, parseEnvNames } from "../src/analyze";
import { parseRepoUrl, RepoUrlError } from "../src/repo-url";
import { chooseFiles, LIMITS, scanRepository, type ScanDeps } from "../src/scanner";
import { decryptToken, encryptToken, getSecretKey } from "../src/token-crypto";
import { deps, tool } from "../src/index";

// ---------- a fake GitHub / GitLab (no network) ----------

interface FakeRepo { files: Record<string, string>; license?: string | null; private?: boolean; lastCommit?: string; commits?: number; requireToken?: string }
const sha = (i: number) => i.toString(16).padStart(40, "0");

function fakeGithub(repo: FakeRepo, log: { url: string; auth?: string | null }[] = []): typeof fetch {
  const paths = Object.keys(repo.files);
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    log.push({ url: String(input), auth });
    if (url.hostname !== "api.github.com") return json({ message: "unexpected host" }, 500);
    if (repo.requireToken && auth !== `Bearer ${repo.requireToken}`) return json({ message: "Not Found" }, 404);
    const p = url.pathname;
    if (p === "/repos/acme/legacy") return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42" } });
    if (p === "/repos/acme/evil") return new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } });
    if (p === "/repositories/42" || p === "/repos/acme/app")
      return json({ description: "Booking app for salons", default_branch: "main", license: repo.license === undefined ? { spdx_id: "MIT", name: "MIT License" } : repo.license ? { spdx_id: repo.license } : null, stargazers_count: 12, forks_count: 1, open_issues_count: 3, archived: false, private: repo.private ?? false, created_at: "2024-01-01T00:00:00Z", pushed_at: repo.lastCommit ?? "2026-09-30T00:00:00Z", topics: ["booking"], homepage: null });
    if (p === "/repos/acme/app/languages") return json({ TypeScript: 8000, CSS: 2000 });
    if (p === "/repos/acme/app/commits") {
      const n = repo.commits ?? 5;
      return json(n === 0 ? [] : Array.from({ length: n }, () => ({ commit: { committer: { date: repo.lastCommit ?? "2026-09-30T00:00:00Z" } } })));
    }
    if (p === "/repos/acme/app/contributors") return json([{ login: "a" }, { login: "b" }]);
    if (p === "/repos/acme/app/git/trees/main") return json({ truncated: false, tree: paths.map((f, i) => ({ path: f, type: "blob", sha: sha(i + 1), size: Buffer.byteLength(repo.files[f]) })) });
    const blob = /^\/repos\/acme\/app\/git\/blobs\/([0-9a-f]{40})$/.exec(p);
    if (blob) {
      const f = paths[parseInt(blob[1], 16) - 1];
      return json({ encoding: "base64", content: Buffer.from(repo.files[f]).toString("base64") });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

const SAMPLE: FakeRepo = {
  files: {
    "README.md": "# Salon Booker\nBook appointments online. Customers sign up and pay a monthly subscription.",
    "package.json": JSON.stringify({ name: "x", license: "MIT", dependencies: { next: "15", react: "19", stripe: "1", "next-auth": "5", pg: "8", "@sendgrid/mail": "7", "@sentry/nextjs": "8" }, devDependencies: { vitest: "3" } }),
    ".env.example": "STRIPE_SECRET_KEY=sk_live_SHOULD_NEVER_BE_STORED\nDATABASE_URL=postgres://user:supersecret@db/app\nSENDGRID_API_KEY=SG.abc\n",
    "LICENSE": "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy",
    "Dockerfile": "FROM node:22\n",
    ".github/workflows/ci.yml": "name: ci\n",
    "src/app/login/page.tsx": "export default () => null",
    "src/app/page.test.ts": "",
    "docs/index.md": "# Docs",
  },
};

const fixedNow = () => new Date("2026-10-03T12:00:00Z");
const mkDeps = (f: typeof fetch): ScanDeps => ({ fetch: f, now: fixedNow });

// ---------- pure pieces ----------

describe("repository URL validation", () => {
  it("accepts GitHub and GitLab URLs and normalises them", () => {
    expect(parseRepoUrl("https://github.com/octocat/Hello-World")).toMatchObject({ provider: "github", owner: "octocat", name: "Hello-World", url: "https://github.com/octocat/Hello-World" });
    expect(parseRepoUrl("https://github.com/octocat/Hello-World.git/")).toMatchObject({ name: "Hello-World" });
    expect(parseRepoUrl("https://github.com/o/r/tree/main/src").url).toBe("https://github.com/o/r");
    expect(parseRepoUrl("https://gitlab.com/group/sub/project/-/tree/main")).toMatchObject({ provider: "gitlab", owner: "group/sub", name: "project" });
  });
  it.each([
    "http://github.com/o/r", "https://evil.com/o/r", "https://github.com.evil.com/o/r", "https://github.com@evil.com/o/r", "https://user:pw@github.com/o/r",
    "https://github.com:8443/o/r", "https://github.com/onlyowner", "https://github.com/o/../r", "https://github.com/o/%2e%2e", "https://api.github.com/repos/o/r",
    "git@github.com:o/r.git", "file:///etc/passwd", "javascript:alert(1)", "", "https://gitlab.com/g",
  ])("rejects %s", (u) => {
    expect(() => parseRepoUrl(u)).toThrow(RepoUrlError);
  });
});

describe("token encryption", () => {
  const key = randomBytes(32);
  it("round-trips, binds to the business, and detects tampering", () => {
    const enc = encryptToken("ghp_secretToken123", key, "biz-1");
    expect(enc).not.toContain("ghp_secretToken123");
    expect(decryptToken(enc, key, "biz-1")).toBe("ghp_secretToken123");
    expect(decryptToken(enc, key, "biz-2")).toBeNull();
    expect(decryptToken(enc.slice(0, -2) + "AA", key, "biz-1")).toBeNull();
    expect(decryptToken(enc, randomBytes(32), "biz-1")).toBeNull();
    expect(encryptToken("ghp_secretToken123", key, "biz-1")).not.toBe(enc); // fresh IV each time
  });
  it("only accepts a 32-byte base64 key", () => {
    expect(getSecretKey({})).toBeNull();
    expect(getSecretKey({ FOUNDEROS_SECRET_KEY: "short" })).toBeNull();
    expect(getSecretKey({ FOUNDEROS_SECRET_KEY: randomBytes(32).toString("base64") })?.length).toBe(32);
  });
});

describe("deterministic analysis", () => {
  it("parses manifests of every supported ecosystem", () => {
    expect(parseDependencies("package.json", JSON.stringify({ dependencies: { Stripe: "1" }, devDependencies: { vitest: "3" } }))).toEqual(["stripe", "vitest"]);
    expect(parseDependencies("requirements.txt", "# c\nDjango==5.0\nstripe>=7 ; python_version>'3'\n-r other.txt\nPsycopg2_binary")).toEqual(["django", "stripe", "psycopg2-binary"]);
    expect(parseDependencies("pyproject.toml", '[project]\ndependencies = ["fastapi>=0.1", "sqlalchemy[asyncio]", "openai"]')).toEqual(expect.arrayContaining(["fastapi", "sqlalchemy", "openai"]));
    expect(parseDependencies("pyproject.toml", '[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3"\n')).toContain("flask");
    expect(parseDependencies("go.mod", "module x\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgithub.com/stripe/stripe-go/v76 v76.1.0\n)")).toContain("github.com/gin-gonic/gin");
    expect(parseDependencies("Cargo.toml", '[dependencies]\naxum = "0.7"\nserde = { version = "1" }\n')).toEqual(["axum", "serde"]);
    expect(parseDependencies("composer.json", JSON.stringify({ require: { "laravel/framework": "^11" } }))).toEqual(["laravel/framework"]);
    expect(parseDependencies("Gemfile", "gem 'rails'\ngem \"devise\"")).toEqual(["rails", "devise"]);
    expect(parseDependencies("pom.xml", "<artifactId>spring-boot-starter-web</artifactId>")).toEqual(["spring-boot-starter-web"]);
    expect(parseDependencies("package.json", "{not json")).toEqual([]);
  });

  it("reads env variable NAMES only", () => {
    expect(parseEnvNames("# c\nSTRIPE_KEY=sk_live_abc\nexport A_B=1\nlower=1\n")).toEqual(["STRIPE_KEY", "A_B"]);
  });

  it("detects declared licenses and license text", () => {
    expect(declaredLicense("package.json", '{"license":"AGPL-3.0"}')).toBe("AGPL-3.0");
    expect(declaredLicense("Cargo.toml", 'license = "MIT OR Apache-2.0"')).toBe("MIT OR Apache-2.0");
    expect(detectLicenseText("GNU AFFERO GENERAL PUBLIC LICENSE Version 3")).toMatch(/AGPL/);
    expect(detectLicenseText("Apache License\nVersion 2.0, January 2004")).toBe("Apache-2.0");
    expect(detectLicenseText("hello")).toBeNull();
  });

  it("detects the stack, services and signals with evidence, worded as signals", () => {
    const a = analyze({
      paths: SAMPLE_PATHS, files: [
        { path: "package.json", text: SAMPLE.files["package.json"] },
        { path: ".env.example", text: SAMPLE.files[".env.example"] },
        { path: "LICENSE", text: SAMPLE.files.LICENSE },
      ],
      repoLicense: null, languages: [{ name: "TypeScript", pct: 80 }, { name: "CSS", pct: 20 }], lastCommitAt: "2026-09-30T00:00:00Z", now: fixedNow(),
    });
    expect(a.frameworks).toEqual(expect.arrayContaining(["Next.js", "React"]));
    expect(a.databases).toContain("PostgreSQL");
    expect(a.services.map((s) => s.name)).toEqual(expect.arrayContaining(["Stripe", "NextAuth/Auth.js", "SendGrid", "Sentry"]));
    expect(a.signals.handlesPayments.value).toBe(true);
    expect(a.signals.handlesPayments.evidence.join(" ")).toMatch(/stripe/i);
    expect(a.signals.handlesUserAccounts.value).toBe(true);
    expect(a.signals.appearsToCollectPersonalData.value).toBe(true);
    expect(a.signals.mayInvolveHealthData.value).toBe(false);
    expect(a.repoLicense).toBe("MIT"); // from the LICENSE text, API gave none
    expect(a.declaredLicenses).toEqual([{ file: "package.json", license: "MIT" }]);
    expect(a.maturity).toMatchObject({ hasTests: true, hasCi: true, hasDocs: true, hasContainerConfig: true, hasLicenseFile: true, hasPrivacyPolicy: false, hasTerms: false, activity: "active" });
    expect(JSON.stringify(a)).not.toContain("sk_live");
  });

  it("finds privacy and terms files, health and children's signals, copyleft hints, and activity levels", () => {
    const a = analyze({
      paths: ["docs/privacy-policy.md", "app/terms/page.tsx", "src/patients/list.ts", "README.md", "node_modules/x/privacy.md"],
      files: [{ path: "README.md", text: "A COPPA-ready app for kids" }, { path: "requirements.txt", text: "pymupdf==1.24\n" }],
      repoLicense: "NOASSERTION", languages: [], lastCommitAt: "2025-01-01T00:00:00Z", now: fixedNow(),
    });
    expect(a.maturity).toMatchObject({ hasPrivacyPolicy: true, hasTerms: true, activity: "dormant" });
    expect(a.signals.mayInvolveHealthData.value).toBe(true);
    expect(a.signals.mayInvolveChildrensData.value).toBe(true);
    expect(a.copyleftHints[0].name).toBe("pymupdf");
    expect(a.repoLicense).toBeNull();
    expect(analyze({ paths: ["node_modules/a/privacy.md"], files: [], repoLicense: null, languages: [], lastCommitAt: null }).maturity).toMatchObject({ hasPrivacyPolicy: false, activity: "unknown" });
  });

  it("does not claim signals without evidence", () => {
    const a = analyze({ paths: ["main.go"], files: [{ path: "go.mod", text: "module x\nrequire github.com/gin-gonic/gin v1.9.0\n" }], repoLicense: null, languages: [], lastCommitAt: null });
    expect(a.frameworks).toEqual(["Gin"]);
    expect(a.signals.handlesPayments.value).toBe(false);
    expect(a.signals.handlesUserAccounts.value).toBe(false);
    expect(a.signals.appearsToCollectPersonalData.value).toBe(false);
  });

  it("diffs two analyses", () => {
    const mk = (files: { path: string; text: string }[], lic: string | null) => ({ analysis: analyze({ paths: files.map((f) => f.path), files, repoLicense: lic, languages: [], lastCommitAt: null }) });
    const d = diffScans(mk([{ path: "package.json", text: '{"dependencies":{"express":"4"}}' }], null), mk([{ path: "package.json", text: '{"dependencies":{"express":"4","stripe":"1"}}' }], "MIT"));
    expect(d.changed).toBe(true);
    expect(d.lines.join("\n")).toMatch(/Third-party services added: Stripe/);
    expect(d.lines.join("\n")).toMatch(/handlesPayments/);
    expect(d.lines.join("\n")).toMatch(/license changed from none found to MIT/);
    const same = mk([], null);
    expect(diffScans(same, same).changed).toBe(false);
  });
});

const SAMPLE_PATHS = Object.keys(SAMPLE.files);

// ---------- scanner against the fake host ----------

describe("scanner", () => {
  it("only picks a small set of useful files", () => {
    const entries = [...Object.keys(SAMPLE.files), "node_modules/a/package.json", "package-lock.json", "src/big.ts", "web/package.json", "a/b/c/d/e/package.json", "docs/privacy.md"].map((path, i) => ({ path, type: "blob" as const, sha: sha(i) }));
    const picked = chooseFiles(entries).map((c) => c.entry.path);
    expect(picked).toEqual(expect.arrayContaining(["README.md", "package.json", "web/package.json", "Dockerfile", ".env.example", "LICENSE", "docs/index.md", "docs/privacy.md"]));
    expect(picked).not.toContain("node_modules/a/package.json");
    expect(picked).not.toContain("package-lock.json");
    expect(picked).not.toContain("src/big.ts");
    expect(picked).not.toContain("a/b/c/d/e/package.json");
  });

  it("scans, keeps excerpts only, never stores env values, and sends the token only to the API host", async () => {
    const log: { url: string; auth?: string | null }[] = [];
    const ref = parseRepoUrl("https://github.com/acme/app");
    const r = await scanRepository(ref, "ghp_tokenvalue1", mkDeps(fakeGithub({ ...SAMPLE, requireToken: "ghp_tokenvalue1" }, log)));
    expect(r.meta).toMatchObject({ defaultBranch: "main", license: "MIT" });
    expect(r.languages[0]).toEqual({ name: "TypeScript", pct: 80 });
    expect(r.activity).toMatchObject({ commitsLast90d: 5, contributors: 2, lastCommitAt: "2026-09-30T00:00:00Z" });
    expect(r.files.map((f) => f.path)).toContain("README.md");
    expect(r.files.find((f) => f.path === ".env.example")?.excerpt).toBe("STRIPE_SECRET_KEY\nDATABASE_URL\nSENDGRID_API_KEY");
    const stored = JSON.stringify(r);
    expect(stored).not.toContain("sk_live");
    expect(stored).not.toContain("supersecret");
    expect(stored).not.toContain("ghp_tokenvalue1");
    expect(log.every((l) => new URL(l.url).hostname === "api.github.com")).toBe(true);
    expect(log.every((l) => l.auth === "Bearer ghp_tokenvalue1")).toBe(true);
    expect(r.analysis.signals.handlesPayments.value).toBe(true);
  });

  it("caps per-file and total bytes", async () => {
    const big = "x".repeat(LIMITS.fileBytes * 3);
    const files: Record<string, string> = { "README.md": big };
    for (let i = 0; i < 10; i++) files[`pkg${i}/package.json`] = JSON.stringify({ name: "p" + i, pad: "y".repeat(LIMITS.fileBytes - 100) });
    const r = await scanRepository(parseRepoUrl("https://github.com/acme/app"), undefined, mkDeps(fakeGithub({ files })));
    expect(r.bytesRead).toBeLessThanOrEqual(LIMITS.totalBytes);
    expect(r.files.find((f) => f.path === "README.md")!.bytes).toBeLessThanOrEqual(LIMITS.fileBytes);
    expect(r.files.find((f) => f.path === "README.md")!.excerpt.length).toBeLessThanOrEqual(LIMITS.excerptReadme);
    expect(r.skipped.some((s) => /limit/.test(s.reason))).toBe(true);
  });

  it("follows a same-host redirect (renamed repo) but refuses to leave the API host", async () => {
    const hops: { url: string }[] = [];
    await scanRepository({ provider: "github", owner: "acme", name: "legacy", url: "https://github.com/acme/legacy" }, "tok_12345678", mkDeps(fakeGithub(SAMPLE, hops))).catch(() => undefined); // the redirect target works; the rest of the sample lives under acme/app
    expect(hops.map((h) => h.url)).toContain("https://api.github.com/repositories/42");
    const log: { url: string }[] = [];
    await expect(scanRepository({ provider: "github", owner: "acme", name: "evil", url: "https://github.com/acme/evil" }, "tok_12345678", mkDeps(fakeGithub(SAMPLE, log)))).rejects.toThrow(/unexpected host/);
    expect(log.some((l) => l.url.includes("evil.example.com"))).toBe(false);
  });

  it("explains private repositories and rate limits without leaking the token", async () => {
    await expect(scanRepository(parseRepoUrl("https://github.com/acme/app"), undefined, mkDeps(fakeGithub({ ...SAMPLE, requireToken: "t" })))).rejects.toThrow(/private, add a read-only access token/);
    const limited = (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
    await expect(scanRepository(parseRepoUrl("https://github.com/acme/app"), "secrettoken99", mkDeps(limited))).rejects.toThrow(/rate limit/);
    await scanRepository(parseRepoUrl("https://github.com/acme/app"), "secrettoken99", mkDeps(limited)).catch((e: Error) => expect(e.message).not.toContain("secrettoken99"));
  });

  it("scans GitLab through gitlab.com/api/v4 only", async () => {
    const hosts: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      hosts.push(u.hostname + u.pathname.slice(0, 7));
      expect((init?.headers as Record<string, string>)["private-token"]).toBe("glpat-abcdef12");
      const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (u.pathname.endsWith("/languages")) return j({ Ruby: 90.5, HTML: 9.5 });
      if (u.pathname.endsWith("/repository/commits")) return j([{ committed_date: "2026-09-01T00:00:00Z" }]);
      if (u.pathname.endsWith("/repository/contributors")) return j([{ name: "a" }]);
      if (u.pathname.endsWith("/repository/tree")) return j([{ id: "1", path: "README.md", type: "blob" }, { id: "2", path: "Gemfile", type: "blob" }]);
      if (u.pathname.includes("/repository/files/README.md/raw")) return new Response("# Hi");
      if (u.pathname.includes("/repository/files/Gemfile/raw")) return new Response("gem 'rails'\ngem 'stripe'");
      if (u.pathname.startsWith("/api/v4/projects/")) return j({ description: "d", default_branch: "main", visibility: "private", license: { nickname: "MIT" }, star_count: 1, forks_count: 0, open_issues_count: 0 });
      return j({}, 404);
    }) as typeof fetch;
    const r = await scanRepository(parseRepoUrl("https://gitlab.com/grp/sub/proj"), "glpat-abcdef12", mkDeps(f));
    expect(new Set(hosts.map((h) => h.split("/")[0]))).toEqual(new Set(["gitlab.com"]));
    expect(r.meta).toMatchObject({ private: true, license: "MIT" });
    expect(r.analysis.frameworks).toContain("Ruby on Rails");
    expect(r.analysis.signals.handlesPayments.value).toBe(true);
  });
});

// ---------- the tool, against Postgres ----------

describe("product tool (database)", () => {
  let env: TestEnv;
  const key = randomBytes(32).toString("base64");
  const originalKey = process.env.FOUNDEROS_SECRET_KEY;
  let log: { url: string; auth?: string | null }[] = [];

  beforeAll(async () => {
    process.env.FOUNDEROS_SECRET_KEY = key;
    deps.now = fixedNow;
    deps.minRescanMs = 0;
    log = [];
    deps.fetch = fakeGithub(SAMPLE, log);
    env = await makeTestEnv([tool], { ai: new FakeAi(["SUMMARY: A salon booking web app for small salons and their customers.\n## What it is\n- Books appointments (evidence: README.md)"]) });
  });
  afterAll(async () => {
    await env.cleanup();
    if (originalKey === undefined) delete process.env.FOUNDEROS_SECRET_KEY;
    else process.env.FOUNDEROS_SECRET_KEY = originalKey;
  });
  afterEach(() => {
    deps.fetch = fakeGithub(SAMPLE, log);
    process.env.FOUNDEROS_SECRET_KEY = key;
  });

  let repoId = "";
  let scanId = "";

  it("rejects bad URLs and unsupported hosts", async () => {
    expect((await call(tool, env.ctx, "POST", "repos", { url: "https://evil.com/a/b" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "repos", { url: "not a url" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "repos", {})).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "repos", { url: "https://github.com/acme/app", token: "bad token\r\nX-Evil: 1" })).status).toBe(400);
    expect(log.length).toBe(0);
  });

  it("links and scans a repository; the encrypted token is stored but never returned", async () => {
    deps.fetch = fakeGithub({ ...SAMPLE, requireToken: "ghp_privateToken1" }, log);
    const r = await call(tool, env.ctx, "POST", "repos", { url: "https://github.com/acme/app", token: "ghp_privateToken1" });
    expect(r.status).toBe(201);
    expect(r.data.tokenNote).toMatch(/saved encrypted/);
    expect(r.data.repo).toMatchObject({ owner: "acme", name: "app", hasToken: true, status: "ok" });
    repoId = r.data.repo.id;
    scanId = r.data.scan.id;
    const [row] = await env.sql<{ token_enc: string }[]>`SELECT token_enc FROM product_repos WHERE id = ${repoId}`;
    expect(row.token_enc).not.toContain("ghp_privateToken1");
    expect(decryptToken(row.token_enc, Buffer.from(key, "base64"), env.ctx.businessId)).toBe("ghp_privateToken1");
    // not in any response the browser can get
    for (const path of ["repos", `repos/${repoId}`, `repos/${repoId}/scans/${scanId}`]) {
      const res = await call(tool, env.ctx, "GET", path);
      expect(JSON.stringify(res.data)).not.toContain("ghp_privateToken1");
      expect(JSON.stringify(res.data)).not.toContain(row.token_enc);
    }
    expect((await call(tool, env.ctx, "POST", "repos", { url: "https://github.com/acme/app" })).status).toBe(409);
  });

  it("re-scans using the stored token, and does not store anything extra in the database", async () => {
    log.length = 0;
    deps.fetch = fakeGithub({ ...SAMPLE, requireToken: "ghp_privateToken1" }, log);
    const r = await call(tool, env.ctx, "POST", `repos/${repoId}/scan`, {});
    expect(r.status).toBe(200);
    expect(log.every((l) => l.auth === "Bearer ghp_privateToken1")).toBe(true);
    const [{ dump }] = await env.sql<{ dump: string }[]>`SELECT string_agg(result::text, '') AS dump FROM product_scans WHERE repo_id = ${repoId}`;
    expect(dump).not.toContain("sk_live");
    expect(dump).not.toContain("supersecret");
    const detail = await call(tool, env.ctx, "GET", `repos/${repoId}`);
    expect(detail.data.scans.length).toBe(2);
  });

  it("without FOUNDEROS_SECRET_KEY a token is used for the scan only and not stored", async () => {
    delete process.env.FOUNDEROS_SECRET_KEY;
    deps.fetch = fakeGithub({ ...SAMPLE, requireToken: "ghp_oneShotToken" }, []);
    const other = await makeTestEnv([tool]);
    try {
      const r = await call(tool, other.ctx, "POST", "repos", { url: "https://github.com/acme/app", token: "ghp_oneShotToken" });
      expect(r.status).toBe(201);
      expect(r.data.tokenNote).toMatch(/not saved/);
      expect(r.data.repo.hasToken).toBe(false);
      const [{ n }] = await other.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM product_repos WHERE token_enc IS NOT NULL AND business_id = ${other.ctx.businessId}`;
      expect(n).toBe(0);
      expect((await call(tool, other.ctx, "PUT", `repos/${r.data.repo.id}/token`, { token: "ghp_whatever123" })).status).toBe(409);
    } finally {
      await other.cleanup();
    }
  });

  it("a failed scan does not leave a repository behind", async () => {
    deps.fetch = fakeGithub({ ...SAMPLE, requireToken: "needed" }, []);
    const r = await call(tool, env.ctx, "POST", "repos", { url: "https://github.com/acme/app2" });
    expect(r.status).toBe(404);
    const list = await call(tool, env.ctx, "GET", "repos");
    expect(list.data.repos.map((x: { name: string }) => x.name)).toEqual(["app"]);
  });

  it("deletes the saved token on request", async () => {
    const r = await call(tool, env.ctx, "DELETE", `repos/${repoId}/token`);
    expect(r.data.hasToken).toBe(false);
    const [row] = await env.sql<{ token_enc: string | null }[]>`SELECT token_enc FROM product_repos WHERE id = ${repoId}`;
    expect(row.token_enc).toBeNull();
    expect((await call(tool, env.ctx, "PUT", `repos/${repoId}/token`, { token: "ghp_newToken9999" })).status).toBe(200);
  });

  it("runs the AI synthesis as an asynchronous job and stores it", async () => {
    const start = await call(tool, env.ctx, "POST", `repos/${repoId}/scans/${scanId}/ai`);
    expect(start.status).toBe(202);
    const prompt = env.ai.calls[0].prompt;
    expect(prompt).toContain("Test Co A"); // business context
    expect(prompt).toContain("Stripe");
    expect(prompt).toContain("README.md");
    expect(prompt).not.toContain("sk_live");
    const poll = await call(tool, env.ctx, "GET", `repos/${repoId}/scans/${scanId}/ai`);
    expect(poll.data.state).toBe("done");
    expect(poll.data.text).toContain("SUMMARY:");
    const detail = await call(tool, env.ctx, "GET", `repos/${repoId}/scans/${scanId}`);
    expect(detail.data.scan.aiSummary).toContain("salon booking");
  });

  it("compares scans and reports what changed", async () => {
    deps.fetch = fakeGithub({ files: { ...SAMPLE.files, "package.json": JSON.stringify({ dependencies: { next: "15", openai: "4" } }), "docs/privacy.md": "# Privacy" }, requireToken: "ghp_newToken9999" }, []);
    expect((await call(tool, env.ctx, "POST", `repos/${repoId}/scan`, {})).status).toBe(200);
    const d = await call(tool, env.ctx, "GET", `repos/${repoId}/compare`);
    expect(d.status).toBe(200);
    expect(d.data.changed).toBe(true);
    expect(d.data.lines.join("\n")).toMatch(/Dependencies removed:.*stripe/);
    expect(d.data.lines.join("\n")).toMatch(/OpenAI/);
    expect(d.data.lines.join("\n")).toMatch(/hasPrivacyPolicy/);
  });

  it("publishes facts, a description, attention, search and resolve", async () => {
    deps.fetch = fakeGithub({ files: { ...SAMPLE.files }, requireToken: "ghp_newToken9999" }, []);
    expect((await call(tool, env.ctx, "POST", `repos/${repoId}/scan`, {})).status).toBe(200); // latest scan: payments, accounts, no privacy file
    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({ linkedRepos: 1, handlesUserAccounts: true, handlesPayments: true, appearsToCollectPersonalData: true, hasPrivacyPolicyInRepo: false, license: "MIT" });
    expect(f.stack).toEqual(expect.arrayContaining(["TypeScript", "Next.js", "PostgreSQL", "Stripe"]));
    expect(typeof f.lastScanAt).toBe("string");
    const d = await tool.describe!(env.ctx);
    expect(d.length).toBeGreaterThan(10);
    expect(d.length).toBeLessThanOrEqual(600);
    const att = await tool.attention!(env.ctx);
    expect(att.find((a) => /no privacy policy/.test(a.title))).toMatchObject({ severity: "review" });
    expect(att.find((a) => /terms of service/.test(a.title))).toBeTruthy();
    expect((await tool.search!(env.ctx, "app", 5))[0]).toMatchObject({ title: "acme/app", href: `/app/t/product/${repoId}` });
    expect(await tool.resolve!(env.ctx, repoId)).toEqual({ title: "acme/app", href: `/app/t/product/${repoId}` });
    expect(await tool.resolve!(env.ctx, "nope")).toBeNull();
    const bc = await env.ctx.context();
    expect(bc.facts.product.linkedRepos).toBe(1);
    expect(bc.summaries.product).toBeTruthy();
    expect((await env.ctx.search("acme")).flatMap((g) => g.hits.map((h) => h.title))).toContain("acme/app");
  });

  it("an empty tool publishes nothing noisy", async () => {
    const other = await makeTestEnv([tool]);
    try {
      expect(await tool.describe!(other.ctx)).toBe("");
      expect(await tool.attention!(other.ctx)).toEqual([]);
      expect(await tool.facts!(other.ctx)).toMatchObject({ linkedRepos: 0, stack: [], lastScanAt: null, license: null });
    } finally {
      await other.cleanup();
    }
  });

  it("uses the deterministic profile when there is no AI summary", async () => {
    const other = await makeTestEnv([tool]);
    try {
      deps.fetch = fakeGithub(SAMPLE, []);
      await call(tool, other.ctx, "POST", "repos", { url: "https://github.com/acme/app" });
      expect(await tool.describe!(other.ctx)).toMatch(/acme\/app: Booking app for salons/);
    } finally {
      await other.cleanup();
    }
  });

  it("isolates businesses", async () => {
    expect((await call(tool, env.other, "GET", "repos")).data.repos).toEqual([]);
    expect((await call(tool, env.other, "GET", `repos/${repoId}`)).status).toBe(404);
    expect((await call(tool, env.other, "POST", `repos/${repoId}/scan`, {})).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `repos/${repoId}`)).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `repos/${repoId}/token`)).status).toBe(404);
    expect((await call(tool, env.other, "GET", `repos/${repoId}/scans/${scanId}`)).status).toBe(404);
    expect((await call(tool, env.other, "POST", `repos/${repoId}/scans/${scanId}/ai`)).status).toBe(404);
    expect(await tool.resolve!(env.other, repoId)).toBeNull();
    expect(await tool.search!(env.other, "acme", 5)).toEqual([]);
    expect(await tool.facts!(env.other)).toMatchObject({ linkedRepos: 0 });
    // the same repo can be linked independently by another business
    deps.fetch = fakeGithub(SAMPLE, []);
    expect((await call(tool, env.other, "POST", "repos", { url: "https://github.com/acme/app" })).status).toBe(201);
  });

  it("links records across tools", async () => {
    await env.ctx.links.add({ tool: "product", id: repoId }, { tool: "product", id: repoId }, "self");
    expect((await env.ctx.links.list({ tool: "product", id: repoId }))[0]).toMatchObject({ title: "acme/app" });
  });

  it("viewers are read-only", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, viewer.ctx, "POST", "repos", { url: "https://github.com/acme/app" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "GET", "repos")).status).toBe(200);
      expect((await call(tool, viewer.ctx, "GET", "status")).status).toBe(200);
    } finally {
      await viewer.cleanup();
    }
    expect((await call(tool, env.ctx, "GET", "status")).data).toMatchObject({ aiAvailable: true, tokenStorage: true });
    const v = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, v.ctx, "DELETE", `repos/${repoId}`)).status).toBe(403);
      expect((await call(tool, v.ctx, "POST", `repos/${repoId}/scan`, {})).status).toBe(403);
      expect((await call(tool, v.ctx, "PUT", `repos/${repoId}/token`, { token: "abcdefgh12" })).status).toBe(403);
    } finally {
      await v.cleanup();
    }
  });

  it("AI unavailable gives a clear message and keeps the scan usable", async () => {
    const noAi = new FakeAi();
    noAi.available = false;
    const e = await makeTestEnv([tool], { ai: noAi });
    try {
      deps.fetch = fakeGithub(SAMPLE, []);
      const r = await call(tool, e.ctx, "POST", "repos", { url: "https://github.com/acme/app" });
      const res = await call(tool, e.ctx, "POST", `repos/${r.data.repo.id}/scans/${r.data.scan.id}/ai`);
      expect(res.status).toBe(503);
    } finally {
      await e.cleanup();
    }
  });

  it("deleting a repository cascades to its scans", async () => {
    expect((await call(tool, env.ctx, "DELETE", `repos/${repoId}`)).status).toBe(200);
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM product_scans WHERE repo_id = ${repoId}`;
    expect(n).toBe(0);
  });
});
