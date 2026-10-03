import { expect, test } from "@playwright/test";
import { SKIP_MSG, hasCreds } from "./support";

test.skip(!hasCreds, SKIP_MSG);

test("create a team invite link, see it listed, open the invite page, and revoke it", async ({ page, browser }) => {
  await page.goto("/app/team");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invite someone" })).toBeVisible();

  await page.getByRole("button", { name: "Create invite link" }).click();
  const region = page.getByRole("region", { name: "New invite link" });
  const link = region.getByLabel("Invite link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);

  try {
    // listed under Invites
    await expect(page.getByRole("heading", { name: "Invites" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Revoke / }).first()).toBeVisible();

    // The invite page for a signed-in member shows the invite screen (or says why it cannot be used, e.g. already a member): never an error page.
    await page.goto(new URL(url).pathname);
    await expect(page.getByRole("heading", { name: "Team invite" })).toBeVisible();
    await expect(page.getByText(/Signed in as/)).toBeVisible();

    // A signed-out visitor is sent to sign in and brought back to the invite afterwards.
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    try {
      const p = await anon.newPage();
      await p.goto(new URL(url).pathname);
      await expect(p).toHaveURL(/\/login\?next=%2Finvite%2F/);
      await expect(p.getByRole("heading", { name: "Sign in to FounderOS" })).toBeVisible();
    } finally {
      await anon.close();
    }
  } finally {
    // Always revoke, so a failing run leaves no live invite link behind.
    await page.goto("/app/team");
    page.once("dialog", (d) => void d.accept());
    const revoke = page.getByRole("button", { name: /^Revoke / }).first();
    if (await revoke.isVisible().catch(() => false)) await revoke.click();
  }
  await expect(page.getByText("Invite revoked.")).toBeVisible();
});

test("a made-up invite link shows a clear message, not a crash", async ({ page }) => {
  await page.goto("/invite/this-token-does-not-exist-0123456789");
  await expect(page.getByRole("heading", { name: "Team invite" })).toBeVisible();
  await expect(page.locator("main [role=alert]")).toContainText(/not valid/i);
});
