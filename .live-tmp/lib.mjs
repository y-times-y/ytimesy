import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
export async function open(width = 1440, height = 1000, path = "/") {
  const s = JSON.parse(readFileSync("/tmp/ytimesy-mint.json", "utf8"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addCookies([{ name: s.cookie.name, value: s.cookie.value, domain: "ytimesy.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  await page.goto("https://ytimesy.com" + path);
  await page.waitForTimeout(4500);
  return { browser, ctx, page };
}
