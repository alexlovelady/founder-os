import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every tool page is rendered inside shell/src/app/app/t/[tool]/[[...path]]/page.tsx, which already renders the one h1 (the tool name) and the
 * description. A tool must not render another h1: it would give the page two titles (bad for screen readers and for the look).
 * Tools start their own top heading at h2. ALLOWLIST is for a tool that truly needs an h1; it is empty and each entry needs a reason.
 */
const ALLOWLIST: Record<string, string> = {};

const root = join(__dirname, "..", "..", "..");
const modulesDir = join(root, "modules");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("one h1 per tool page", () => {
  const files = readdirSync(modulesDir)
    .filter((m) => m !== "legal") // modules/legal is the separate LegalAI app (its own UI, not a FounderOS tool page)
    .flatMap((m) => {
      const src = join(modulesDir, m, "src");
      try {
        return tsxFiles(src);
      } catch {
        return [];
      }
    });

  it("scans the tool sources", () => expect(files.length).toBeGreaterThan(10));

  it("no tool renders an h1", () => {
    const offenders = files
      .filter((f) => /<h1[\s>]/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"))
      .filter((f) => !(f in ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it("the shell wrapper renders exactly one h1", () => {
    const page = readFileSync(join(root, "shell", "src", "app", "app", "t", "[tool]", "[[...path]]", "page.tsx"), "utf8");
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
  });
});
