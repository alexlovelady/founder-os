/**
 * Deterministic analysis of a scanned repository. Pure functions: everything here works from names (dependencies, env variables, file paths),
 * never from running code. Every conclusion carries the evidence it came from, and is worded as "appears to".
 */

export type Category = "framework" | "database" | "payments" | "auth" | "analytics" | "monitoring" | "email" | "messaging" | "cloud" | "ai" | "storage";

export interface ScanFile { path: string; text: string }

export interface Detection { category: Category; name: string; evidence: string[] }

export interface Signal { value: boolean; evidence: string[] }

export interface Maturity {
  hasReadme: boolean;
  hasTests: boolean;
  hasCi: boolean;
  hasDocs: boolean;
  hasContainerConfig: boolean;
  hasLicenseFile: boolean;
  hasPrivacyPolicy: boolean;
  hasTerms: boolean;
  activity: "active" | "slowing" | "dormant" | "unknown";
}

export interface Analysis {
  languages: string[];
  frameworks: string[];
  databases: string[];
  services: Detection[];
  /** All detections including frameworks and databases, with evidence. */
  detections: Detection[];
  signals: {
    handlesUserAccounts: Signal;
    handlesPayments: Signal;
    appearsToCollectPersonalData: Signal;
    mayInvolveHealthData: Signal;
    mayInvolveChildrensData: Signal;
    usesAiProviders: Signal;
  };
  repoLicense: string | null;
  declaredLicenses: { file: string; license: string }[];
  copyleftHints: { name: string; note: string }[];
  maturity: Maturity;
  /** Distinct dependency names found in the manifests read (capped), used for comparing scans. */
  dependencies: string[];
  envVarNames: string[];
  manifests: string[];
}

export interface AnalyzeInput {
  paths: string[];
  files: ScanFile[];
  repoLicense: string | null;
  languages: { name: string; pct: number }[];
  lastCommitAt: string | null;
  now?: Date;
}

// ---------- manifests ----------

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();

export const MANIFEST_NAMES = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "cargo.toml", "composer.json", "gemfile", "pom.xml"];

export function parseDependencies(path: string, text: string): string[] {
  const name = base(path);
  const out = new Set<string>();
  try {
    if (name === "package.json" || name === "composer.json") {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "require", "require-dev"]) {
        const o = j[k];
        if (o && typeof o === "object") for (const d of Object.keys(o)) out.add(d.toLowerCase());
      }
    } else if (name === "requirements.txt") {
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith("#") || l.startsWith("-")) continue;
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
        if (m) out.add(m[1].toLowerCase().replace(/_/g, "-"));
      }
    } else if (name === "pyproject.toml") {
      // PEP 621 arrays of strings and Poetry tables.
      for (const m of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;(][^"']*)?["']/g)) {
        if (/^(python|and|or)$/i.test(m[1])) continue;
        out.add(m[1].toLowerCase().replace(/_/g, "-"));
      }
      const poetry = /\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
      for (const sec of text.matchAll(poetry)) {
        for (const m of sec[1].matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) if (m[1].toLowerCase() !== "python") out.add(m[1].toLowerCase().replace(/_/g, "-"));
      }
    } else if (name === "go.mod") {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+v[0-9]/gim)) out.add(m[1].toLowerCase());
    } else if (name === "cargo.toml") {
      for (const sec of text.matchAll(/\[(?:[a-z-]+\.)?(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
        for (const m of sec[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) out.add(m[1].toLowerCase());
      }
    } else if (name === "gemfile") {
      for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) out.add(m[1].toLowerCase());
    } else if (name === "pom.xml") {
      for (const m of text.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) out.add(m[1].toLowerCase());
    }
  } catch {
    /* unparseable manifest: no dependencies recorded */
  }
  return [...out];
}

export function parseEnvNames(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*[=:]/.exec(line);
    if (m) out.add(m[1]); // names only, values are never read
  }
  return [...out];
}

export function declaredLicense(path: string, text: string): string | null {
  const name = base(path);
  try {
    if (name === "package.json" || name === "composer.json") {
      const j = JSON.parse(text) as { license?: unknown; licenses?: unknown };
      if (typeof j.license === "string") return j.license;
      if (Array.isArray(j.license)) return j.license.map(String).join(", ");
      if (j.license && typeof (j.license as { type?: string }).type === "string") return (j.license as { type: string }).type;
      return null;
    }
    if (name === "pyproject.toml") {
      const m = /^\s*license\s*=\s*(?:"([^"]+)"|\{[^}]*(?:text|file)\s*=\s*"([^"]+)"[^}]*\})/m.exec(text);
      if (m) return m[1] ?? m[2];
      const c = /License ::\s*(?:OSI Approved ::\s*)?([^"'\n]+)/.exec(text);
      return c ? c[1].trim() : null;
    }
    if (name === "cargo.toml") return /^\s*license\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
    if (name === "pom.xml") return /<licenses>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
  return null;
}

export function detectLicenseText(text: string): string | null {
  const t = text.slice(0, 3000).toLowerCase();
  if (/gnu affero general public license/.test(t)) return "AGPL (see LICENSE)";
  if (/gnu lesser general public license/.test(t)) return "LGPL (see LICENSE)";
  if (/gnu general public license/.test(t)) return "GPL (see LICENSE)";
  if (/apache license/.test(t) && /version 2\.0/.test(t)) return "Apache-2.0";
  if (/mozilla public license/.test(t)) return "MPL-2.0";
  if (/permission is hereby granted, free of charge/.test(t)) return "MIT";
  if (/redistribution and use in source and binary forms/.test(t)) return /neither the name|endorse or promote/.test(t) ? "BSD-3-Clause" : "BSD (2/3-clause)";
  if (/this is free and unencumbered software/.test(t)) return "Unlicense";
  if (/isc license|permission to use, copy, modify, and\/or distribute/.test(t)) return "ISC";
  if (/business source license/.test(t)) return "BUSL (source-available)";
  return null;
}

// ---------- detection rules ----------

interface Rule { name: string; category: Category; deps?: string[]; env?: RegExp }

/** deps: exact names, or a trailing "*" for a prefix match (e.g. "@clerk/*"). */
const RULES: Rule[] = [
  // frameworks
  { name: "Next.js", category: "framework", deps: ["next"] },
  { name: "React", category: "framework", deps: ["react", "react-dom"] },
  { name: "Vue", category: "framework", deps: ["vue"] },
  { name: "Nuxt", category: "framework", deps: ["nuxt"] },
  { name: "Svelte", category: "framework", deps: ["svelte", "@sveltejs/kit"] },
  { name: "Angular", category: "framework", deps: ["@angular/core"] },
  { name: "Astro", category: "framework", deps: ["astro"] },
  { name: "Remix", category: "framework", deps: ["@remix-run/*"] },
  { name: "Express", category: "framework", deps: ["express"] },
  { name: "Fastify", category: "framework", deps: ["fastify"] },
  { name: "NestJS", category: "framework", deps: ["@nestjs/core"] },
  { name: "React Native", category: "framework", deps: ["react-native", "expo"] },
  { name: "Electron", category: "framework", deps: ["electron"] },
  { name: "Django", category: "framework", deps: ["django"] },
  { name: "Flask", category: "framework", deps: ["flask"] },
  { name: "FastAPI", category: "framework", deps: ["fastapi"] },
  { name: "Ruby on Rails", category: "framework", deps: ["rails"] },
  { name: "Laravel", category: "framework", deps: ["laravel/framework"] },
  { name: "Symfony", category: "framework", deps: ["symfony/*"] },
  { name: "Spring Boot", category: "framework", deps: ["spring-boot-starter*", "spring-boot"] },
  { name: "Gin", category: "framework", deps: ["github.com/gin-gonic/gin"] },
  { name: "Echo", category: "framework", deps: ["github.com/labstack/echo*"] },
  { name: "Fiber", category: "framework", deps: ["github.com/gofiber/fiber*"] },
  { name: "Actix", category: "framework", deps: ["actix-web"] },
  { name: "Axum", category: "framework", deps: ["axum"] },
  // databases
  { name: "PostgreSQL", category: "database", deps: ["pg", "postgres", "psycopg", "psycopg2", "psycopg2-binary", "asyncpg", "github.com/lib/pq", "github.com/jackc/pgx*", "tokio-postgres", "pgvector"], env: /^(POSTGRES|PG)(_|$)|POSTGRES_URL/ },
  { name: "MySQL/MariaDB", category: "database", deps: ["mysql", "mysql2", "pymysql", "mysqlclient", "github.com/go-sql-driver/mysql", "mysql-connector-java"], env: /^MYSQL_/ },
  { name: "SQLite", category: "database", deps: ["sqlite3", "better-sqlite3", "aiosqlite", "rusqlite"] },
  { name: "MongoDB", category: "database", deps: ["mongodb", "mongoose", "pymongo", "motor", "go.mongodb.org/mongo-driver"], env: /^MONGO(DB)?_/ },
  { name: "Redis", category: "database", deps: ["redis", "ioredis", "redis-py", "github.com/redis/go-redis*"], env: /^REDIS_/ },
  { name: "Prisma ORM", category: "database", deps: ["prisma", "@prisma/client"] },
  { name: "Drizzle ORM", category: "database", deps: ["drizzle-orm"] },
  { name: "TypeORM/Sequelize/Knex", category: "database", deps: ["typeorm", "sequelize", "knex"] },
  { name: "SQLAlchemy", category: "database", deps: ["sqlalchemy"] },
  { name: "Elasticsearch", category: "database", deps: ["@elastic/elasticsearch", "elasticsearch"] },
  { name: "Firebase/Firestore", category: "database", deps: ["firebase", "firebase-admin", "@google-cloud/firestore"], env: /^FIREBASE_/ },
  { name: "Supabase", category: "database", deps: ["@supabase/*", "supabase"], env: /^SUPABASE_/ },
  { name: "DynamoDB", category: "database", deps: ["@aws-sdk/client-dynamodb"] },
  // payments
  { name: "Stripe", category: "payments", deps: ["stripe", "@stripe/*", "stripe-python"], env: /^STRIPE_/ },
  { name: "PayPal", category: "payments", deps: ["paypal*", "@paypal/*", "paypalrestsdk"], env: /^PAYPAL_/ },
  { name: "Braintree", category: "payments", deps: ["braintree"], env: /^BRAINTREE_/ },
  { name: "Square", category: "payments", deps: ["square", "squareup"], env: /^SQUARE_/ },
  { name: "Paddle", category: "payments", deps: ["@paddle/*", "paddle-python-sdk"], env: /^PADDLE_/ },
  { name: "Lemon Squeezy", category: "payments", deps: ["@lemonsqueezy/*"], env: /^LEMON_?SQUEEZY_/ },
  { name: "Adyen", category: "payments", deps: ["adyen", "@adyen/*"], env: /^ADYEN_/ },
  { name: "Razorpay", category: "payments", deps: ["razorpay"], env: /^RAZORPAY_/ },
  { name: "Mollie", category: "payments", deps: ["@mollie/*", "mollie-api-python"], env: /^MOLLIE_/ },
  { name: "Plaid (bank data)", category: "payments", deps: ["plaid", "plaid-python", "react-plaid-link"], env: /^PLAID_/ },
  // auth
  { name: "NextAuth/Auth.js", category: "auth", deps: ["next-auth", "@auth/*"], env: /^(NEXTAUTH|AUTH)_(SECRET|URL)/ },
  { name: "Passport", category: "auth", deps: ["passport", "passport-*"] },
  { name: "Auth0", category: "auth", deps: ["auth0", "@auth0/*", "auth0-python"], env: /^AUTH0_/ },
  { name: "Clerk", category: "auth", deps: ["@clerk/*"], env: /^(NEXT_PUBLIC_)?CLERK_/ },
  { name: "Okta", category: "auth", deps: ["@okta/*", "okta"], env: /^OKTA_/ },
  { name: "Keycloak", category: "auth", deps: ["keycloak-js", "python-keycloak"], env: /^KEYCLOAK_/ },
  { name: "Lucia/Better Auth", category: "auth", deps: ["lucia", "better-auth"] },
  { name: "Password hashing / JWT libraries", category: "auth", deps: ["bcrypt", "bcryptjs", "argon2", "argon2-cffi", "passlib", "jsonwebtoken", "jose", "pyjwt", "python-jose", "authlib", "django-allauth", "devise", "omniauth", "github.com/golang-jwt/jwt*"], env: /^(JWT_|SESSION_SECRET|COOKIE_SECRET)/ },
  { name: "OAuth sign-in (Google/GitHub/etc.)", category: "auth", env: /^(GOOGLE|GITHUB|FACEBOOK|MICROSOFT|APPLE|TWITTER|LINKEDIN)_(CLIENT_ID|CLIENT_SECRET|OAUTH)/ },
  // analytics
  { name: "Google Analytics", category: "analytics", deps: ["react-ga*", "@next/third-parties", "ga-gtag", "vue-gtag"], env: /^(GA_|GOOGLE_ANALYTICS|GTAG|NEXT_PUBLIC_GA)/ },
  { name: "Vercel Analytics", category: "analytics", deps: ["@vercel/analytics"] },
  { name: "Mixpanel", category: "analytics", deps: ["mixpanel", "mixpanel-browser"], env: /^MIXPANEL_/ },
  { name: "Segment", category: "analytics", deps: ["@segment/*", "analytics-node", "analytics-python"], env: /^SEGMENT_/ },
  { name: "PostHog", category: "analytics", deps: ["posthog-js", "posthog-node", "posthog"], env: /POSTHOG_/ },
  { name: "Amplitude", category: "analytics", deps: ["@amplitude/*", "amplitude-js"], env: /^AMPLITUDE_/ },
  { name: "Plausible/Hotjar/Heap/FullStory", category: "analytics", deps: ["plausible-tracker", "react-hotjar", "@hotjar/*", "heap-api", "@fullstory/*"] },
  // monitoring
  { name: "Sentry", category: "monitoring", deps: ["@sentry/*", "sentry-sdk"], env: /^SENTRY_/ },
  { name: "Datadog", category: "monitoring", deps: ["dd-trace", "ddtrace", "datadog*"], env: /^(DD_|DATADOG_)/ },
  { name: "New Relic/Rollbar/Bugsnag/LogRocket", category: "monitoring", deps: ["newrelic", "rollbar", "@bugsnag/*", "logrocket"] },
  // email & messaging
  { name: "SendGrid", category: "email", deps: ["@sendgrid/*", "sendgrid"], env: /^SENDGRID_/ },
  { name: "Mailgun", category: "email", deps: ["mailgun*", "mailgun.js"], env: /^MAILGUN_/ },
  { name: "Postmark", category: "email", deps: ["postmark", "postmarker"], env: /^POSTMARK_/ },
  { name: "Resend", category: "email", deps: ["resend"], env: /^RESEND_/ },
  { name: "Nodemailer/SMTP", category: "email", deps: ["nodemailer"], env: /^(SMTP_|MAIL_(HOST|SERVER)|EMAIL_(HOST|SERVER))/ },
  { name: "Mailchimp", category: "email", deps: ["@mailchimp/*", "mailchimp*"], env: /^MAILCHIMP_/ },
  { name: "Amazon SES", category: "email", deps: ["@aws-sdk/client-ses*"] },
  { name: "Twilio", category: "messaging", deps: ["twilio"], env: /^TWILIO_/ },
  { name: "Slack/Discord bots", category: "messaging", deps: ["@slack/*", "slack-sdk", "discord.js", "discord.py"], env: /^(SLACK|DISCORD)_/ },
  // cloud
  { name: "AWS", category: "cloud", deps: ["aws-sdk", "@aws-sdk/*", "boto3", "botocore"], env: /^AWS_/ },
  { name: "Google Cloud", category: "cloud", deps: ["@google-cloud/*", "google-cloud-*"], env: /^(GCP_|GOOGLE_CLOUD|GOOGLE_APPLICATION_CREDENTIALS)/ },
  { name: "Azure", category: "cloud", deps: ["@azure/*", "azure-*"], env: /^AZURE_/ },
  { name: "Cloudflare", category: "cloud", deps: ["wrangler", "@cloudflare/*"], env: /^CLOUDFLARE_/ },
  { name: "Vercel", category: "cloud", deps: ["vercel", "@vercel/*"], env: /^VERCEL_/ },
  { name: "Cloudinary / uploads", category: "storage", deps: ["cloudinary", "uploadthing", "@uploadthing/*"], env: /^(CLOUDINARY_|UPLOADTHING_|S3_)/ },
  // AI
  { name: "OpenAI", category: "ai", deps: ["openai"], env: /^OPENAI_/ },
  { name: "Anthropic", category: "ai", deps: ["anthropic", "@anthropic-ai/*"], env: /^ANTHROPIC_/ },
  { name: "Google Gemini", category: "ai", deps: ["@google/generative-ai", "google-generativeai", "@google/genai"], env: /^(GEMINI_|GOOGLE_AI)/ },
  { name: "LangChain / LlamaIndex", category: "ai", deps: ["langchain*", "@langchain/*", "llama-index*", "llamaindex"] },
  { name: "Hugging Face / local models", category: "ai", deps: ["transformers", "torch", "tensorflow", "@huggingface/*", "huggingface-hub", "ollama", "vllm", "llama-cpp-python"], env: /^(HF_|HUGGINGFACE_|OLLAMA_)/ },
  { name: "Cohere / Mistral / Replicate", category: "ai", deps: ["cohere", "cohere-ai", "mistralai", "@mistralai/*", "replicate"], env: /^(COHERE_|MISTRAL_|REPLICATE_)/ },
];

const COPYLEFT: { dep: string; note: string }[] = [
  { dep: "pymupdf", note: "PyMuPDF is AGPL-3.0 (or commercial); check the obligations before offering it as a service" },
  { dep: "fitz", note: "fitz/PyMuPDF is AGPL-3.0 (or commercial)" },
  { dep: "itextpdf", note: "iText is AGPL-3.0 (or commercial)" },
  { dep: "ghostscript", note: "Ghostscript is AGPL-3.0 (or commercial)" },
  { dep: "mysql-connector-python", note: "MySQL connector is GPL-2.0 with a FOSS exception; check the terms" },
];

function depMatches(pattern: string, dep: string): boolean {
  return pattern.endsWith("*") ? dep.startsWith(pattern.slice(0, -1)) : dep === pattern;
}

// ---------- path signals ----------

export const IGNORED_PATH = /(^|\/)(node_modules|vendor|dist|build|\.next|\.git|third_party|site-packages|__pycache__)\//i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i;
const CI_PATH = /^(\.github\/workflows\/.+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/|jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.yml)/i;
export const PRIVACY_FILE = /(^|\/)(privacy([-_ ]?(policy|notice))?|cookie[-_ ]?policy)[^/]*\.(md|mdx|txt|html?|rst|pdf|tsx?|jsx?|vue|svelte|php)$/i;
const PRIVACY_DIR = /(^|\/)(privacy|privacy-policy)\/(page|index)\.[a-z]+$/i;
export const TERMS_FILE = /(^|\/)(terms([-_ ]?(of[-_ ]?(service|use)|and[-_ ]?conditions|conditions))?|tos|eula)[^/]*\.(md|mdx|txt|html?|rst|pdf|tsx?|jsx?|vue|svelte|php)$/i;
const TERMS_DIR = /(^|\/)(terms|terms-of-service|tos)\/(page|index)\.[a-z]+$/i;

const ACCOUNT_PATH = /(^|\/)(login|signin|sign-in|signup|sign-up|register|registration|auth|accounts?|users?|profile)(\/|\.|$)/i;
const PERSONAL_PATH = /(^|\/)(customers?|contacts?|patients?|members?|subscribers?|profiles?|users?)(\/|\.|$)/i;
const HEALTH_RE = /\b(hipaa|fhir|hl7|patients?|medical|clinical|ehr|emr|telehealth|diagnos\w+|prescriptions?)\b/i;
const CHILD_RE = /\b(coppa|children|childrens|kids?|k-12|k12|minors?|students?|under 13|pupils?)\b/i;

// ---------- main ----------

export function analyze(input: AnalyzeInput): Analysis {
  const now = input.now ?? new Date();
  const paths = input.paths.filter((p) => !IGNORED_PATH.test(p));
  const found = new Map<string, Detection>();
  const add = (rule: Rule, evidence: string) => {
    const key = `${rule.category}:${rule.name}`;
    const d = found.get(key) ?? { category: rule.category, name: rule.name, evidence: [] };
    if (d.evidence.length < 3 && !d.evidence.includes(evidence)) d.evidence.push(evidence);
    found.set(key, d);
  };

  const deps = new Set<string>();
  const envNames = new Set<string>();
  const manifests: string[] = [];
  const declared: { file: string; license: string }[] = [];
  let readmeText = "";
  let licenseFileText = "";

  for (const f of input.files) {
    const name = base(f.path);
    if (MANIFEST_NAMES.includes(name)) {
      manifests.push(f.path);
      const found2 = parseDependencies(f.path, f.text);
      for (const d of found2) {
        deps.add(d);
        for (const r of RULES) if (r.deps?.some((p) => depMatches(p, d))) add(r, `dependency "${d}" in ${f.path}`);
      }
      const lic = declaredLicense(f.path, f.text);
      if (lic) declared.push({ file: f.path, license: lic.slice(0, 120) });
    } else if (/^\.env(\.|$)/.test(name) || /\.env\.(example|sample|template)$/.test(name) || name === "env.example") {
      for (const n of parseEnvNames(f.text)) {
        envNames.add(n);
        for (const r of RULES) if (r.env?.test(n)) add(r, `environment variable ${n} in ${f.path}`);
      }
    } else if (/^readme(\.|$)/.test(name) && !readmeText) {
      readmeText = f.text;
    } else if (/^(license|licence|copying|unlicense)(\.|$)/.test(name) && !licenseFileText) {
      licenseFileText = f.text;
    }
  }

  const detections = [...found.values()];
  const names = (c: Category) => detections.filter((d) => d.category === c).map((d) => d.name);
  const evidenceOf = (cats: Category[]) => detections.filter((d) => cats.includes(d.category)).flatMap((d) => d.evidence.map((e) => `${d.name}: ${e}`));
  const pathHits = (re: RegExp, limit = 3) => paths.filter((p) => re.test(p)).slice(0, limit);

  const accountEvidence = [...evidenceOf(["auth"]), ...pathHits(ACCOUNT_PATH).map((p) => `file path ${p}`)];
  const paymentEvidence = evidenceOf(["payments"]);
  const personalEvidence = [
    ...accountEvidence,
    ...evidenceOf(["email", "messaging", "analytics"]),
    ...paymentEvidence,
    ...pathHits(PERSONAL_PATH).map((p) => `file path ${p}`),
    ...[...envNames].filter((n) => /(EMAIL|PHONE|ADDRESS)/.test(n)).slice(0, 2).map((n) => `environment variable ${n}`),
  ];
  const healthText = [...paths, ...[...deps], readmeText.slice(0, 4000)].join("\n");
  const healthHit = HEALTH_RE.exec(healthText);
  const childHit = CHILD_RE.exec([...paths, ...deps].join("\n") + "\n" + readmeText.slice(0, 4000));

  const age = input.lastCommitAt ? (now.getTime() - new Date(input.lastCommitAt).getTime()) / 86400000 : null;
  const maturity: Maturity = {
    hasReadme: input.files.some((f) => /^readme(\.|$)/.test(base(f.path))) || paths.some((p) => /^readme(\.|$)/i.test(p)),
    hasTests: paths.some((p) => TEST_PATH.test(p)),
    hasCi: paths.some((p) => CI_PATH.test(p)),
    hasDocs: paths.some((p) => /^(docs?|documentation)\//i.test(p)),
    hasContainerConfig: paths.some((p) => /(^|\/)(dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i.test(p)),
    hasLicenseFile: paths.some((p) => /^(license|licence|copying|unlicense)(\.|$)/i.test(p)),
    hasPrivacyPolicy: paths.some((p) => PRIVACY_FILE.test(p) || PRIVACY_DIR.test(p)),
    hasTerms: paths.some((p) => TERMS_FILE.test(p) || TERMS_DIR.test(p)),
    activity: age == null || Number.isNaN(age) ? "unknown" : age <= 90 ? "active" : age <= 365 ? "slowing" : "dormant",
  };

  const apiLicense = input.repoLicense && !/^(noassertion|other)$/i.test(input.repoLicense) ? input.repoLicense : null;
  const repoLicense = apiLicense ?? (licenseFileText ? detectLicenseText(licenseFileText) : null);

  return {
    languages: input.languages.filter((l) => l.pct >= 1).map((l) => l.name),
    frameworks: names("framework"),
    databases: names("database"),
    services: detections.filter((d) => !["framework", "database"].includes(d.category)),
    detections,
    signals: {
      handlesUserAccounts: { value: accountEvidence.length > 0, evidence: accountEvidence.slice(0, 5) },
      handlesPayments: { value: paymentEvidence.length > 0, evidence: paymentEvidence.slice(0, 5) },
      appearsToCollectPersonalData: { value: personalEvidence.length > 0, evidence: [...new Set(personalEvidence)].slice(0, 6) },
      mayInvolveHealthData: { value: Boolean(healthHit), evidence: healthHit ? [`the term "${healthHit[0]}" appears in file names, dependencies or the README`] : [] },
      mayInvolveChildrensData: { value: Boolean(childHit), evidence: childHit ? [`the term "${childHit[0]}" appears in file names, dependencies or the README`] : [] },
      usesAiProviders: { value: names("ai").length > 0, evidence: evidenceOf(["ai"]).slice(0, 4) },
    },
    repoLicense,
    declaredLicenses: declared,
    copyleftHints: COPYLEFT.filter((c) => deps.has(c.dep)).map((c) => ({ name: c.dep, note: c.note })),
    maturity,
    dependencies: [...deps].sort().slice(0, 600),
    envVarNames: [...envNames].sort().slice(0, 200),
    manifests,
  };
}

// ---------- comparing two scans ----------

export interface ScanDiff {
  changed: boolean;
  lines: string[];
}

interface Comparable {
  analysis: Analysis;
  meta?: { defaultBranch?: string | null };
  activity?: { lastCommitAt?: string | null; commitsLast90d?: number | null };
}

const list = (a: string[], b: string[]) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });

export function diffScans(older: Comparable, newer: Comparable): ScanDiff {
  const lines: string[] = [];
  const o = older.analysis;
  const n = newer.analysis;
  const push = (label: string, d: { added: string[]; removed: string[] }) => {
    if (d.added.length) lines.push(`${label} added: ${d.added.slice(0, 12).join(", ")}${d.added.length > 12 ? ` (+${d.added.length - 12} more)` : ""}`);
    if (d.removed.length) lines.push(`${label} removed: ${d.removed.slice(0, 12).join(", ")}${d.removed.length > 12 ? ` (+${d.removed.length - 12} more)` : ""}`);
  };
  push("Frameworks", list(o.frameworks, n.frameworks));
  push("Databases", list(o.databases, n.databases));
  push("Third-party services", list(o.services.map((s) => s.name), n.services.map((s) => s.name)));
  push("Languages", list(o.languages, n.languages));
  push("Dependencies", list(o.dependencies, n.dependencies));
  for (const k of Object.keys(n.signals) as (keyof Analysis["signals"])[]) {
    if (o.signals[k]?.value !== n.signals[k].value) lines.push(`Signal "${k}" changed from ${o.signals[k]?.value ? "appears" : "not seen"} to ${n.signals[k].value ? "appears" : "not seen"}`);
  }
  if (o.repoLicense !== n.repoLicense) lines.push(`Repository license changed from ${o.repoLicense ?? "none found"} to ${n.repoLicense ?? "none found"}`);
  for (const k of Object.keys(n.maturity) as (keyof Maturity)[]) {
    if (o.maturity[k] !== n.maturity[k]) lines.push(`Maturity: ${k} changed from ${String(o.maturity[k])} to ${String(n.maturity[k])}`);
  }
  if (older.meta?.defaultBranch !== newer.meta?.defaultBranch && newer.meta?.defaultBranch) lines.push(`Default branch changed to ${newer.meta.defaultBranch}`);
  if (older.activity?.lastCommitAt !== newer.activity?.lastCommitAt && newer.activity?.lastCommitAt) lines.push(`Last commit moved to ${newer.activity.lastCommitAt.slice(0, 10)}`);
  return { changed: lines.length > 0, lines };
}
