import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";
import { EMAIL, SKIP_MSG, STATE_FILE, hasCreds, login } from "./support";

setup("sign in with the LegalAI test account", async ({ page }) => {
  mkdirSync(".auth", { recursive: true });
  if (!hasCreds) {
    writeFileSync(STATE_FILE, JSON.stringify({ cookies: [], origins: [] }));
    setup.skip(true, SKIP_MSG);
  }
  await login(page);
  // the signed-in shell shows who is signed in (the sidebar is hidden on small screens, so look in the DOM)
  await expect(page.getByText(EMAIL).first()).toBeAttached();
  await page.context().storageState({ path: STATE_FILE });
});
