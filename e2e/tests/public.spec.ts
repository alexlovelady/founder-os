import { expect, test } from "@playwright/test";

// No account needed: the public site and the free calculators.

test.describe("public pages", () => {
  for (const [path, heading] of [
    ["/", /./],
    ["/pricing", /pricing|plans/i],
    ["/features", /./],
    ["/security", /security/i],
    ["/terms", /terms/i],
    ["/privacy", /privacy/i],
    ["/tools", /tools|calculator/i],
  ] as const) {
    test(`${path} renders`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(heading);
    });
  }

  test("the sign-in page is reachable and signed-out visitors are sent there", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to FounderOS" })).toBeVisible();
    await page.goto("/app/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("robots and sitemap are served", async ({ request }) => {
    expect((await request.get("/robots.txt")).status()).toBe(200);
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain("<urlset");
  });

  test("health check answers", async ({ request }) => {
    expect((await request.get("/healthz")).status()).toBe(200);
  });

  test("the shell API refuses signed-out and cross-site calls", async ({ request, baseURL }) => {
    expect((await request.get("/api/search?q=test")).status()).toBe(401);
    const cross = await request.post("/api/links", { headers: { origin: "https://evil.example", cookie: "x=1" }, data: {} });
    expect(cross.status()).toBe(403);
    const same = await request.post("/api/links", { headers: { origin: baseURL!, cookie: "x=1" }, data: {} });
    expect(same.status()).toBe(401);
  });
});

test.describe("free calculators compute", () => {
  test("runway: defaults, then new inputs change the result", async ({ page }) => {
    await page.goto("/tools/runway-calculator");
    // defaults: cash 30000, revenue 2000 + 1000, expenses 8000 -> burn 5000 -> 6 months
    await expect(page.getByText("6 months")).toBeVisible();
    await page.getByLabel("Cash in the bank").fill("60000");
    await expect(page.getByText("12 months")).toBeVisible();
    await page.getByLabel("Monthly expenses").fill("2500");
    await expect(page.getByText(/Not burning cash|None: revenue covers spending/).first()).toBeVisible();
  });

  test("break-even: 1000 fixed, price 50, cost 20 -> 34 sales", async ({ page }) => {
    await page.goto("/tools/break-even-calculator");
    await expect(page.getByText("$30.00")).toBeVisible(); // profit per sale
    await expect(page.getByText("34", { exact: true })).toBeVisible();
    await page.getByLabel("Price per sale").fill("40");
    await expect(page.getByText("$20.00")).toBeVisible();
    await expect(page.getByText("50", { exact: true })).toBeVisible();
  });

  test("pricing: cost 100 at 50% margin -> $200.00", async ({ page }) => {
    await page.goto("/tools/pricing-calculator");
    await expect(page.getByText("$200.00").first()).toBeVisible();
    await page.getByLabel(/margin/i).fill("20");
    await expect(page.getByText("$125.00").first()).toBeVisible();
  });

  test("calculators say nothing is saved or sent", async ({ page }) => {
    await page.goto("/tools/runway-calculator");
    await expect(page.getByText(/Nothing on this page was saved or sent anywhere/)).toBeVisible();
  });

  test("the startup checklist tailors itself to the answers", async ({ page }) => {
    await page.goto("/tools/startup-checklist");
    await expect(page.getByText(/Showing the full starter list/)).toBeVisible();
    await page.getByRole("radio").first().check();
    await expect(page.getByText(/Tailored from 1 of \d+ answers/)).toBeVisible();
  });

  test("the business health check gives results only after every question is answered", async ({ page }) => {
    await page.goto("/tools/business-health-check");
    const submit = page.getByRole("button", { name: "See my results" });
    await expect(submit).toBeDisabled();
    // answer every question with its first option
    const names = await page.locator("input[type=radio]").evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLInputElement).name))]);
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) await page.locator(`input[type=radio][name="${name}"]`).first().check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("heading", { name: "Your results" })).toBeVisible();
  });
});
