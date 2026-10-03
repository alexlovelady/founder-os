import { expect, test } from "@playwright/test";
import { SKIP_MSG, hasCreds, login } from "./support";

test.skip(!hasCreds, SKIP_MSG);

// Logs in on its own and runs after every other signed-in project (see playwright.config.ts).
test("sign out ends the session: the app and the API both refuse afterwards", async ({ page, request }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  expect((await page.request.get("/api/search?q=test")).status()).toBe(200);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in to FounderOS" })).toBeVisible();

  // the browser no longer has a session, so protected pages bounce to sign-in
  await page.goto("/app/dashboard");
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get("/api/search?q=test")).status()).toBe(401);
  // and a fresh client without cookies never had one
  expect((await request.get("/api/search?q=test")).status()).toBe(401);
});
