import { expect, test } from "@playwright/test";
import { BASE, SKIP_MSG, hasCreds, runTag, sameSite } from "./support";

test.skip(!hasCreds, SKIP_MSG);

const tag = runTag();
const filename = `e2e-note-${tag}.txt`;
const body = `FounderOS end-to-end test file ${tag}\nline two of the file\n`;

test("upload a small text document to the vault and download the same bytes back", async ({ page, request }) => {
  let docId = "";
  try {
    await page.goto("/app/t/vault");
    await expect(page.getByRole("heading", { name: "Document vault" }).first()).toBeVisible();
    await page.getByLabel("Choose files to upload").setInputFiles({ name: filename, mimeType: "text/plain", buffer: Buffer.from(body) });
    await expect(page.getByText(/Uploaded 1 file/)).toBeVisible();
    const link = page.getByRole("link", { name: `e2e-note-${tag}` });
    await expect(link).toBeVisible();

    await link.click();
    await expect(page).toHaveURL(/\/app\/t\/vault\/d\/[0-9a-f-]{36}/);
    docId = page.url().split("/d/")[1].split(/[?#]/)[0];
    await expect(page.getByRole("heading", { name: `e2e-note-${tag}` }).first()).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download" }).first().click();
    const d = await download;
    expect(d.suggestedFilename()).toBe(filename);
    const path = await d.path();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path, "utf8")).toBe(body);

    // the same file over the API: attachment, fixed safe type, nosniff
    const res = await request.get(`${BASE}/api/tools/vault/documents/${docId}/download`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toMatch(/attachment/);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await res.text()).toBe(body);
  } finally {
    if (docId) await request.delete(`${BASE}/api/tools/vault/documents/${docId}`, { headers: sameSite }).catch(() => undefined);
  }
});

test("files that are not what they claim to be are refused", async ({ page, request }) => {
  await page.goto("/app/t/vault");
  await page.getByLabel("Choose files to upload").setInputFiles({ name: `fake-${tag}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf at all") });
  await expect(page.getByText(/does not look like a real PDF/i)).toBeVisible();
  // nothing was stored under that name
  const list = await request.get(`${BASE}/api/tools/vault/documents?q=${tag}`);
  expect((await list.json()).documents).toHaveLength(0);
});
