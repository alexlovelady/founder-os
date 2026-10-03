import { expect, test } from "@playwright/test";
import { SKIP_MSG, hasCreds, runTag } from "./support";

test.skip(!hasCreds, SKIP_MSG);

test.describe("onboarding and dashboard", () => {
  test("a signed-in account without a business is walked through onboarding; one with a business goes straight to the dashboard", async ({ page }) => {
    await page.goto("/app/onboarding");
    await page.waitForURL(/\/app\/(onboarding|dashboard)/);

    if (/\/app\/onboarding/.test(page.url())) {
      const name = `E2E Cleaning ${runTag()} LLC`;
      await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();
      await page.getByLabel("Business name").fill(name);
      await page.getByLabel("What does it do?").fill("Residential cleaning (created by the end-to-end test)");
      await page.getByLabel("State").selectOption("North Carolina");
      await page.getByLabel("How is it set up?").selectOption("llc");
      await page.getByLabel("People on the team").fill("2");
      await page.getByLabel("We have employees").check();
      await page.getByRole("button", { name: "Stay compliant" }).click();
      await page.getByRole("button", { name: "Create my workspace" }).click();
      await expect(page).toHaveURL(/\/app\/welcome/);
      await expect(page.getByRole("heading", { name: /We created your business workspace/ })).toBeVisible();
      await expect(page.getByText(name).first()).toBeVisible();
    } else {
      test.info().annotations.push({ type: "note", description: "Account already has a business, so the onboarding form was not shown. Use a fresh account to cover the form." });
      await expect(page).toHaveURL(/\/app\/dashboard/);
    }
  });

  test("the dashboard shows the business, attention items and the sidebar", async ({ page }) => {
    await page.goto("/app/dashboard");
    await expect(page).toHaveURL(/\/app\/dashboard/);
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Upcoming" })).toBeVisible();
    await expect(page.getByText(/your role: (owner|admin|member|viewer)/)).toBeVisible();
    // the dashboard has real content from the tools: either attention items or the explicit empty message
    const items = page.locator("section[aria-labelledby=att-title] li");
    const empty = page.getByText(/Nothing from your tools needs attention right now/);
    await expect(items.first().or(empty)).toBeVisible();
    // navigation to the tools
    const nav = page.locator("aside").first();
    for (const label of ["Tasks & reminders", "Document vault", "Team"]) await expect(nav.getByRole("link", { name: label }).first()).toBeVisible();
  });

  test("the tools respond to navigation from the sidebar", async ({ page }) => {
    await page.goto("/app/dashboard");
    await page.locator("aside").first().getByRole("link", { name: "Tasks & reminders" }).click();
    await expect(page).toHaveURL(/\/app\/t\/tasks/);
    await expect(page.getByRole("heading", { name: /Tasks/ }).first()).toBeVisible();
  });
});
