import assert from "node:assert/strict";
import { chromium } from "playwright-core";

/** Run with the component Vite fixture already listening. No GitHub or model calls. */
const origin = process.env.GITHUB_COMPONENT_ORIGIN ?? "http://127.0.0.1:3101";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
	context.pages().find((page) => page.url().startsWith(origin)) ??
	(await context.newPage());
await page.bringToFront();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const actions = () =>
	page.evaluate(
		() =>
			(window as unknown as { githubFixtureCalls: Record<string, unknown>[] })
				.githubFixtureCalls,
	);
const latest = async () => (await actions()).at(-1);
const button = (name: string) =>
	page.getByRole("button", { name, exact: true });
const tab = (name: string) =>
	page.getByRole("tab", { name: new RegExp(`^${name}`) });
try {
	await page.setViewportSize({ width: 1200, height: 780 });
	await page.goto(`${origin}/tests/fixtures/github-collaboration.html`);
	await page.getByRole("table").waitFor();
	assert.equal(await page.locator(".gh-table tbody tr").count(), 18);
	assert.equal(await page.getByText("Needs you", { exact: true }).count(), 0);
	await page.getByRole("searchbox").fill("#74");
	assert.equal(await page.locator(".gh-table tbody tr").count(), 1);
	await page.locator(".gh-table-open").click();
	await button("Review changes").waitFor();
	await page.evaluate(() =>
		(
			window as unknown as {
				githubFixtureRefuseNext: (message: string) => void;
			}
		).githubFixtureRefuseNext("GitHub App needs Pull requests: write."),
	);
	await page
		.getByRole("textbox", { name: "Add a comment", exact: true })
		.fill("Keyboard selection verified.");
	await button("Comment").click();
	await page
		.getByRole("alert")
		.filter({ hasText: "GitHub App needs Pull requests: write." })
		.waitFor();
	assert.equal(
		await page
			.getByRole("textbox", { name: "Add a comment", exact: true })
			.inputValue(),
		"Keyboard selection verified.",
	);
	await button("Comment").click();
	await page
		.getByText("Keyboard selection verified.", { exact: true })
		.waitFor();
	assert.equal((await latest())?.action, "comment");
	await button("Reply").click();
	await page
		.getByRole("textbox", { name: "Reply", exact: true })
		.fill("Anchor preservation is included.");
	await page
		.locator(".gh-composer-actions")
		.getByRole("button", { name: "Reply", exact: true })
		.click();
	await page
		.getByText("Anchor preservation is included.", { exact: true })
		.waitFor();
	assert.equal((await latest())?.action, "reply");
	await button("Resolve conversation").click();
	await page.getByText("Resolved conversation on", { exact: false }).waitFor();
	assert.equal((await latest())?.action, "resolve-thread");
	await tab("Files").click();
	await page
		.getByRole("button", {
			name: "Comment on new line 2 of src/editor.ts",
			exact: true,
		})
		.click();
	await button("Suggest change").click();
	const line = page.getByRole("textbox", {
		name: "Comment on line 2",
		exact: true,
	});
	assert.match(await line.inputValue(), /```suggestion/);
	await line.fill("```suggestion\n  return selection.anchor;\n```");
	await button("Add to review").click();
	await page.getByRole("button", { name: /^Review changes/ }).click();
	await page
		.getByRole("textbox", { name: "Review summary", exact: true })
		.fill("Please preserve the selection anchor.");
	await page.getByRole("radio", { name: /Request changes/ }).check();
	await button("Submit review").click();
	await page.locator(".gh-review-popover").waitFor({ state: "hidden" });
	assert.equal((await latest())?.event, "REQUEST_CHANGES");
	const reviewedComments = (await latest())?.comments;
	assert(Array.isArray(reviewedComments));
	assert.equal(reviewedComments.length, 1);
	await button("Review changes").click();
	await page.getByRole("radio", { name: /^Approve/ }).check();
	await button("Submit review").click();
	await page.locator(".gh-review-popover").waitFor({ state: "hidden" });
	assert.equal((await latest())?.event, "APPROVE");
	await tab("Checks").click();
	await page
		.getByRole("button", { name: "Log of browser-checks", exact: true })
		.click();
	await page.getByText(/FAIL selection.spec.ts/).waitFor();
	await button("Re-run failed jobs").click();
	assert.equal((await latest())?.action, "rerun");
	await page.getByRole("tab", { name: /^Conversation/ }).click();
	await page.getByRole("button", { name: "Edit title", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Title", exact: true })
		.fill("Persist selections and anchors");
	await button("Save").click();
	await page
		.getByRole("heading", { name: "Persist selections and anchors" })
		.waitFor();
	await button("Edit labels").click();
	await page
		.getByRole("menuitemcheckbox", { name: "enhancement", exact: true })
		.click();
	await page.keyboard.press("Escape");
	await page.waitForFunction(
		() =>
			(
				window as unknown as { githubFixtureCalls: { action: string }[] }
			).githubFixtureCalls.at(-1)?.action === "labels",
	);
	await button("Edit reviewers").click();
	await page
		.getByRole("menuitemcheckbox", { name: "riley", exact: true })
		.click();
	await page.keyboard.press("Escape");
	await page.waitForFunction(
		() =>
			(
				window as unknown as { githubFixtureCalls: { action: string }[] }
			).githubFixtureCalls.at(-1)?.action === "reviewers",
	);
	await button("Edit assignees").click();
	await page
		.getByRole("menuitemcheckbox", { name: "morgan", exact: true })
		.click();
	await page.keyboard.press("Escape");
	await page.waitForFunction(
		() =>
			(
				window as unknown as { githubFixtureCalls: { action: string }[] }
			).githubFixtureCalls.at(-1)?.action === "assignees",
	);
	await button("Close pull request").click();
	await button("Reopen pull request").waitFor();
	await button("Reopen pull request").click();
	await button("Close pull request").waitFor();
	await page
		.locator(".qa-nav")
		.getByRole("button", { name: "Issues", exact: true })
		.click();
	await page.locator(".gh-issue-row").click();
	await page
		.getByRole("textbox", { name: "Add a comment", exact: true })
		.fill("Confirmed on a second file.");
	await button("Comment").click();
	await page
		.getByText("Confirmed on a second file.", { exact: true })
		.waitFor();
	await button("Close as not planned").click();
	await button("Reopen issue").waitFor();
	await button("Reopen issue").click();
	await button("Close issue").waitFor();
	await page
		.getByRole("button", {
			name: "#74 Keep editor selections when switching files",
			exact: true,
		})
		.click();
	await button("Review changes").waitFor();
	assert.equal(
		await page
			.getByRole("heading", { name: "Persist selections and anchors" })
			.count(),
		1,
	);
	await page
		.locator(".qa-nav")
		.getByRole("button", { name: "Issues", exact: true })
		.click();
	await button("New issue").click();
	await page
		.getByRole("textbox", { name: "Title", exact: true })
		.fill("Retain undo history on a renamed file");
	await page
		.getByRole("textbox", { name: "Description", exact: true })
		.fill("Rename a file, then undo an earlier edit.");
	await button("Create issue").click();
	await page
		.getByRole("heading", { name: "Retain undo history on a renamed file" })
		.waitFor();
	assert.equal((await latest())?.action, "create");
	await page.setViewportSize({ width: 320, height: 740 });
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
		true,
	);
	await page.getByRole("button", { name: "All issues", exact: true }).click();
	await button("New issue").waitFor();
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
		true,
	);
	await page
		.locator(".qa-nav")
		.getByRole("button", { name: "Pull requests", exact: true })
		.click();
	await page.getByRole("table").waitFor();
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
		true,
	);
	assert.equal(
		await page
			.locator(".gh-scroll-viewport")
			.evaluate((element) => element.scrollWidth > element.clientWidth),
		true,
	);
	await page.locator(".gh-table-open").first().click();
	await page.setViewportSize({ width: 320, height: 480 });
	await button("Review changes").click();
	const reviewBounds = await page
		.locator(".gh-review-popover")
		.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return { top: rect.top, bottom: rect.bottom, height: innerHeight };
		});
	assert(
		reviewBounds.top >= 0 && reviewBounds.bottom <= reviewBounds.height,
		"Review controls must stay inside a short phone viewport",
	);
	await page
		.locator(".gh-review-popover")
		.getByRole("radio", { name: /Request changes/ })
		.scrollIntoViewIfNeeded();
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1200, height: 780 });
	assert.deepEqual(errors, []);
	console.log(
		`PASS: dense list/search, comments, reply, resolve, inline suggestion + change-request review, CI log/rerun, title/labels, close/reopen PR + issue, in-app linked PR, new issue, and 320px overflow checks (${(await actions()).length} simulated writes).`,
	);
} finally {
	await browser.close();
}
