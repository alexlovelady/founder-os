import { expect, test, type APIRequestContext } from "@playwright/test";
import { BASE, SKIP_MSG, hasCreds, runTag, sameSite } from "./support";

test.skip(!hasCreds, SKIP_MSG);

// Create a task and a CRM contact, link them from the contact page, and find both with Ctrl+K.
const tag = runTag();
const taskTitle = `Call supplier ${tag}`;
const contactName = `Taylor ${tag}`;

async function removeByName(request: APIRequestContext, tool: "tasks" | "crm", needle: string) {
  const url = tool === "tasks" ? `${BASE}/api/tools/tasks/items?limit=500` : `${BASE}/api/tools/crm/contacts?q=${encodeURIComponent(needle)}`;
  const res = await request.get(url);
  if (!res.ok()) return;
  const data = await res.json();
  const rows: { id: string; title?: string; name?: string }[] = tool === "tasks" ? data.tasks : data.contacts;
  for (const r of rows.filter((x) => (x.title ?? x.name ?? "").includes(needle))) {
    await request.delete(`${BASE}/api/tools/${tool}/${tool === "tasks" ? "items" : "contacts"}/${r.id}`, { headers: sameSite }).catch(() => undefined);
  }
}

test.describe.serial("tasks, CRM, links and search", () => {
  test.afterAll(async ({ request }) => {
    await removeByName(request, "tasks", tag);
    await removeByName(request, "crm", tag);
  });

  test("create a task", async ({ page }) => {
    await page.goto("/app/t/tasks");
    await page.getByLabel("New task").fill(taskTitle);
    await page.getByLabel("New task").press("Enter");
    await expect(page.getByRole("button", { name: taskTitle })).toBeVisible();
    // it persists
    await page.reload();
    await expect(page.getByRole("button", { name: taskTitle })).toBeVisible();
  });

  test("complete and reopen the task", async ({ page }) => {
    await page.goto("/app/t/tasks");
    await page.getByRole("checkbox", { name: `Complete ${taskTitle}` }).click();
    await expect(page.getByRole("checkbox", { name: `Reopen ${taskTitle}` })).toBeChecked();
    await page.getByRole("checkbox", { name: `Reopen ${taskTitle}` }).click();
    await expect(page.getByRole("checkbox", { name: `Complete ${taskTitle}` })).not.toBeChecked();
  });

  test("add a CRM contact", async ({ page }) => {
    await page.goto("/app/t/crm");
    await page.getByRole("button", { name: "Add contact" }).click();
    const form = page.getByRole("form", { name: "Add contact" });
    await form.getByLabel("Name *").fill(contactName);
    await form.getByLabel("Company").fill("Taylor Supply");
    await form.getByLabel("Email").fill(`${tag}@example.com`);
    await form.getByRole("button", { name: "Save contact" }).click();
    await expect(page.getByRole("link", { name: new RegExp(contactName) })).toBeVisible();
  });

  test("link the task to the contact from the contact page", async ({ page }) => {
    await page.goto("/app/t/crm");
    await page.getByRole("link", { name: new RegExp(contactName) }).click();
    await expect(page.getByRole("heading", { name: contactName })).toBeVisible();
    const linked = page.getByRole("region", { name: "Linked items" });
    await linked.getByRole("button", { name: "Link something" }).click();
    await linked.getByPlaceholder(/Search your contacts/).fill(tag);
    await linked.getByRole("button", { name: new RegExp(taskTitle) }).click();
    await expect(linked.getByRole("link", { name: new RegExp(taskTitle) })).toBeVisible();
    // the link survives a reload
    await page.reload();
    await expect(page.getByRole("region", { name: "Linked items" }).getByRole("link", { name: new RegExp(taskTitle) })).toBeVisible();
  });

  test("Ctrl+K finds both records", async ({ page }) => {
    await page.goto("/app/dashboard");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search and commands" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox").fill(tag);
    const results = dialog.getByRole("listbox", { name: "Search results" });
    await expect(results.getByRole("option", { name: new RegExp(taskTitle) })).toBeVisible();
    await expect(results.getByRole("option", { name: new RegExp(contactName) })).toBeVisible();
    // Enter opens the highlighted hit
    await dialog.getByRole("combobox").press("Enter");
    await expect(page).toHaveURL(/\/app\/t\/(tasks|crm)/);
  });

  test("Escape closes the search", async ({ page }) => {
    await page.goto("/app/dashboard");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search and commands" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Search and commands" })).toBeHidden();
  });
});
