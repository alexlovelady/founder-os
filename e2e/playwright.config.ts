import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for the critical flows that need neither the AI nor Stripe (build spec section 66).
// Run against any running stack: E2E_BASE_URL (default http://localhost:3000). Signed-in tests need E2E_EMAIL and E2E_PASSWORD
// for a LegalAI test account on that stack; they skip with a clear message when those are unset. See docs/E2E.md.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // One worker, in order: the signed-in tests share one account and the sign-out test must run last.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  projects: [
    { name: "public", testMatch: /public\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "app", testMatch: /app-.*\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState: ".auth/user.json" } },
    { name: "mobile", testMatch: /mobile\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Pixel 7"], storageState: ".auth/user.json" } },
    // Signing out can end the session, so it runs after every other signed-in project and logs in on its own.
    { name: "signout", testMatch: /signout\.spec\.ts/, dependencies: ["app", "mobile"], use: { ...devices["Desktop Chrome"] } },
  ],
});
