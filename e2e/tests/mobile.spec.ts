import { expect, test } from "@playwright/test";
import { SKIP_MSG, hasCreds } from "./support";

test.skip(!hasCreds, SKIP_MSG);

// Runs in the "mobile" project (Pixel 7 viewport).
test("on a phone the sidebar becomes a slide-out menu that closes after navigating", async ({ page }) => {
  await page.goto("/app/dashboard");
  const menuButton = page.getByRole("button", { name: "Open menu" });
  await expect(menuButton).toBeVisible();
  // the desktop sidebar is not on screen
  await expect(page.getByRole("link", { name: "Tasks & reminders" })).toBeHidden();

  await menuButton.click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "Tasks & reminders" }).click();
  await expect(page).toHaveURL(/\/app\/t\/tasks/);
  await expect(menu).toBeHidden();
  await expect(page.getByRole("heading", { name: /Tasks/ }).first()).toBeVisible();
});

test("the menu closes with Escape and with the backdrop", async ({ page }) => {
  await page.goto("/app/dashboard");
  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Close menu" }).click({ position: { x: 340, y: 400 } });
  await expect(menu).toBeHidden();
});

test("no horizontal scrolling on the main pages", async ({ page }) => {
  for (const path of ["/app/dashboard", "/app/t/tasks", "/app/t/crm", "/app/team"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test("the public site works on a phone too", async ({ page }) => {
  await page.goto("/tools/runway-calculator");
  await expect(page.getByText("6 months")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
