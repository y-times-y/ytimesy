import type { MemoryProject } from "./memory-layout";

/**
 * The read hook's offline precision fixture: a memory with two projects and
 * personal notes, a web-project chat's requests with the lines that are
 * right for them, and requests that must recall nothing. Shared by
 * memory-precision.test.ts and scripts/memory-rerank-calibrate.ts, which
 * scores every probe against every in-scope line with the real reranker.
 */

export const PRECISION_PROJECT: MemoryProject = {
	fullName: "acme/web",
	repositoryIds: [1],
};

export const PRECISION_FILES = {
	"personal/style.md": [
		"- Prefers short replies without preamble",
		"- Writes commit messages in the imperative mood",
		"- Works on a Mac with zsh",
	].join("\n"),
	// Both filed under personal/ on dev and recalled for unrelated messages
	// (2026-11-02): the reranker must keep them out of those.
	"personal/customer-reporting.md":
		"- In customer summaries, `orders` counts input rows per customer, not item quantities; keep order counts distinct from quantity totals.",
	"personal/startup-lessons.md":
		"- From the Notion page on startup strategy: talk to users every week, launch before it feels ready, and win one narrow wedge before expanding.",
	"projects/acme-web--1/tooling.md": [
		"- Install packages with pnpm, never npm",
		"- Run vitest for unit tests",
		"- Node is pinned to 22",
	].join("\n"),
	"projects/acme-web--1/api.md": [
		"- API errors return problem+json",
		"- Routes live under /api/v2",
		"- Timestamps are stored in UTC",
	].join("\n"),
	"projects/acme-web--1/deploy.md": [
		"- Deploy with wrangler to Cloudflare Workers",
		"- Never deploy on Fridays",
	].join("\n"),
	"projects/acme-api--2/tooling.md": [
		"- Install packages with yarn",
		"- Run pytest for unit tests",
		"- Python is pinned to 3.12",
	].join("\n"),
	"projects/acme-api--2/deploy.md": "- Deploy with fly to Fly.io",
	"projects/acme-api--2/api.md": [
		"- API errors return a JSON error envelope",
		"- Store timestamps as unix seconds",
	].join("\n"),
};

/** A web-project chat's requests and the lines that are right for each. */
export const PRECISION_PROBES: { query: string; right: string[] }[] = [
	{
		query: "install the date-fns package",
		right: ["Install packages with pnpm, never npm"],
	},
	{
		query: "add a unit test for the price parser",
		right: ["Run vitest for unit tests"],
	},
	{
		query: "deploy the latest build",
		right: [
			"Deploy with wrangler to Cloudflare Workers",
			"Never deploy on Fridays",
		],
	},
	{
		query: "return an error from the orders route when items are missing",
		right: ["API errors return problem+json", "Routes live under /api/v2"],
	},
	{
		query: "store the created timestamp on each order",
		right: ["Timestamps are stored in UTC"],
	},
	// Asked for as a must-recall-nothing message, but this memory has the
	// project's test command: recalling it is right (reranker 0.97).
	{ query: "run the tests", right: ["Run vitest for unit tests"] },
	{
		query: "add an orders column to the customer summary report",
		right: [
			"In customer summaries, `orders` counts input rows per customer, not item quantities; keep order counts distinct from quantity totals.",
		],
	},
];

/**
 * Messages that must recall nothing: the two dev messages that recalled the
 * personal lines above (2026-11-02), and generic chat.
 */
export const PRECISION_NEGATIVES: string[] = [
	"Reply with just the word OK.",
	"Without running anything: what exactly was my first message in this chat, and what did you reply?",
	"hi",
	"thanks, looks good",
	"what did you just do?",
	"continue",
];
