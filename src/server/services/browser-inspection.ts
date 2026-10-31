import { z } from "zod";

export const browserAssertion = z.object({
	selector: z.string().min(1).max(500),
	expectedText: z.string().max(2000).optional(),
	visible: z.boolean().default(true),
});

export const browserInspection = z.object({
	passed: z.boolean(),
	url: z.string(),
	title: z.string(),
	snapshot: z.string(),
	truncated: z.boolean(),
	controls: z.array(
		z.object({
			tag: z.string(),
			role: z.string(),
			label: z.string(),
			type: z.string(),
		}),
	),
	assertions: z.array(
		z.object({
			selector: z.string(),
			passed: z.boolean(),
			reason: z.string(),
		}),
	),
	console: z.array(z.object({ type: z.string(), text: z.string() })),
	network: z.array(
		z.object({ url: z.string(), method: z.string(), status: z.number() }),
	),
	observationMilliseconds: z.number(),
});

// Trusted guest program: no arbitrary page evaluation, request headers, cookies or form values.
// The page asked for matches Chrome's own URL ignoring a trailing "/" and a #fragment.
export const BROWSER_INSPECTION_SOURCE = `
import { createRequire } from 'node:module';
const require = createRequire(process.argv[1] + '/package.json');
const { chromium } = require('playwright-core');
const input = JSON.parse(process.argv[2]);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 });
try {
  const same = (value) => { try { const url = new URL(value); url.hash = ''; return url.href.endsWith('/') ? url.href.slice(0, -1) : url.href; } catch { return value; } };
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = pages.find(page => page.url() === input.url) ?? pages.find(page => same(page.url()) === same(input.url));
  if (!page) throw new Error('The requested page is not open in the shared browser. Open pages: ' + (pages.map(page => page.url()).filter(url => /^https?:/.test(url)).join(', ') || 'none') + '.');
  const cleanUrl = value => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return url.protocol; url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.href; };
  const consoleEntries = [];
  const network = [];
  page.on('console', message => {
    if (consoleEntries.length < 30) consoleEntries.push({ type: message.type(), text: message.text().slice(0, 1000) });
  });
  page.on('pageerror', error => {
    if (consoleEntries.length < 30) consoleEntries.push({ type: 'pageerror', text: error.message.slice(0, 1000) });
  });
  page.on('response', response => {
    if (network.length < 50) network.push({ url: cleanUrl(response.url()), method: response.request().method(), status: response.status() });
  });
  const assertions = [];
  for (const assertion of input.assertions) {
    const locator = page.locator(assertion.selector);
    const count = await locator.count();
    const visible = count === 1 && await locator.isVisible();
    const actualText = count === 1 ? await locator.innerText({ timeout: 3000 }).catch(() => '') : '';
    const passed = count === 1 && visible === assertion.visible && (assertion.expectedText === undefined || actualText.includes(assertion.expectedText));
    assertions.push({ selector: assertion.selector, passed, reason: passed ? 'Matched' : count !== 1 ? 'Selector must match exactly one element' : visible !== assertion.visible ? 'Visibility differed' : 'Expected text was not found' });
  }
  await page.waitForTimeout(input.observeMilliseconds);
  const snapshot = await page.locator('body').innerText({ timeout: 5000 });
  const controls = await page.locator('button,a,input,textarea,select,[role="button"]').evaluateAll(nodes => nodes.slice(0, 100).map(node => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || '', type: node.getAttribute('type') || '', label: (node.getAttribute('aria-label') || (node.matches('button,a,[role="button"]') ? node.textContent : '') || '').slice(0, 200) })));
  console.log(JSON.stringify({ passed: assertions.every(assertion => assertion.passed), url: cleanUrl(page.url()), title: (await page.title()).slice(0, 1000), snapshot: snapshot.slice(0, 24000), truncated: snapshot.length > 24000, controls, assertions, console: consoleEntries, network, observationMilliseconds: input.observeMilliseconds }));
} finally {
  await browser.close();
}
`;
