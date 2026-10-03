import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const EMAIL = process.env.E2E_EMAIL ?? "";
export const PASSWORD = process.env.E2E_PASSWORD ?? "";
export const hasCreds = Boolean(EMAIL && PASSWORD);
export const SKIP_MSG = "Signed-in E2E tests skipped: set E2E_EMAIL and E2E_PASSWORD to a LegalAI test account on the stack under test (see docs/E2E.md).";
export const STATE_FILE = ".auth/user.json";

/** A short unique tag so records made by one run are easy to find and never collide with real data. */
export const runTag = (): string => `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Sign in through the real login page. */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\//);
}

/** Same-site headers for cleanup calls made outside the browser: the shell rejects state-changing API calls that carry a session cookie but no Origin. */
export const sameSite = { origin: BASE };

/** Best-effort cleanup through the product's own API; never fails the test. */
export async function cleanup(request: APIRequestContext, paths: string[]): Promise<void> {
  for (const p of paths) {
    await request.delete(`${BASE}/api/tools/${p}`, { headers: sameSite }).catch(() => undefined);
  }
}
