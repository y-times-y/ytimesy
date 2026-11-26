import { open } from "./lib.mjs";
const w = Number(process.argv[2] || 1440), tag = process.argv[3] || "d";
const { browser, page } = await open(w, w < 500 ? 844 : 1000);
const out = {};
await page.getByRole("button", { name: "Reject all" }).click().catch(() => {});
await page.locator('[aria-label="Open left sidebar"]').first().click().catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: `/tmp/c-${tag}-sidebar.png` });
await page.locator('[data-captain-id] button.sidebar-chat').first().click();
await page.waitForTimeout(3500);
out.url = page.url();
out.header = await page.locator('[data-role="captain"]').innerText().catch(() => null);
out.layout = await page.locator(".welcome-content").getAttribute("data-layout").catch(() => null);
if (w >= 500) {
  await page.locator("textarea").last().fill("In one sentence: who are you and what do you look after? Do not use tools.");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(3000); if ((await page.locator(".session-markdown").count()) > 1) break; }
  await page.waitForTimeout(4000);
  out.reply = (await page.locator(".session-markdown").last().innerText().catch(() => "")).slice(0, 300);
  // the captain is not a thread
  out.threadsListMentionsSeo = await page.locator('section:has(h3:text-is("Threads")) >> text=/seo|captain/i').count();
}
await page.screenshot({ path: `/tmp/c-${tag}-chat.png` });
console.log(JSON.stringify(out, null, 1));
await browser.close();
