import { describe, expect, it } from "vitest";
import {
	EVIDENCE_END,
	type EvidenceManifest,
	evidenceFileUrl,
	evidenceManifest,
	evidencePlanFor,
	evidenceRefName,
	evidenceRefPullNumber,
	evidenceRequestFromText,
	evidenceSectionState,
	evidenceUserLabel,
	renderEvidenceSection,
	visiblePath,
	withEvidenceSection,
} from "./pr-evidence";

const sha = "c3c0528b5e6e62912fb34a066cf13a9fb81eb770";

function manifest(overrides: Partial<EvidenceManifest> = {}) {
	return evidenceManifest.parse({
		version: 1,
		mode: "verify",
		kind: "web",
		status: "captured",
		sha,
		clean: true,
		startCommand: "pnpm dev",
		startSource: "plan",
		urls: ["http://localhost:5173/", "http://localhost:5173/settings"],
		pages: [
			{
				url: "http://localhost:5173/",
				status: 200,
				title: "Home",
				screenshot: "01-home.png",
			},
			{
				url: "http://localhost:5173/settings",
				status: 500,
				title: "",
				screenshot: null,
				error: "net::ERR",
			},
		],
		flow: [
			{ step: "click text=Save", ok: true, screenshot: null },
			{ step: "screenshot saved", ok: true, screenshot: "02-saved.png" },
		],
		video: { file: "recording.webm", seconds: 9.6 },
		files: [
			{ name: "01-home.png", bytes: 10, sha256: "a".repeat(64) },
			{ name: "02-saved.png", bytes: 10, sha256: "b".repeat(64) },
			{
				name: "recording.webm",
				bytes: 2 * 1024 * 1024,
				sha256: "c".repeat(64),
			},
		],
		browser: "Chrome 155 headless, Playwright 1.63.0",
		viewport: "1280x800",
		startedAt: "2026-10-18T16:45:11Z",
		appReadyAt: "2026-10-18T16:45:13Z",
		finishedAt: "2026-10-18T16:45:17Z",
		...overrides,
	});
}

const links = Object.fromEntries(
	["01-home.png", "02-saved.png", "recording.webm"].map((name) => [
		name,
		`https://github.com/owner/app/blob/${"e".repeat(40)}/${name}?raw=true`,
	]),
);

describe("capture plans", () => {
	it("accepts the plan ytimesy-evidence saves and refuses pages outside the workspace", () => {
		const saved = {
			version: 1,
			mode: "web",
			start: "node server.js",
			urls: ["/about", "http://localhost:4317/"],
			flow: [{ action: "click", selector: "text=Save" }],
			startSeconds: 90,
		};
		expect(evidenceRequestFromText(JSON.stringify(saved))).toMatchObject({
			mode: "web",
			urls: ["/about", "http://localhost:4317/"],
		});
		for (const url of [
			"https://example.com/",
			"//evil.example/x",
			"http://user:pw@localhost:3000/",
			"file:///etc/passwd",
		])
			expect(
				evidenceRequestFromText(JSON.stringify({ ...saved, urls: [url] })),
			).toBeNull();
		expect(
			evidenceRequestFromText(
				JSON.stringify({ ...saved, start: "pnpm dev\nrm -rf /" }),
			),
		).toBeNull();
		expect(
			evidenceRequestFromText(
				JSON.stringify({
					...saved,
					flow: Array.from({ length: 21 }, () => ({ action: "wait", ms: 1 })),
				}),
			),
		).toBeNull();
		expect(
			evidenceRequestFromText(
				JSON.stringify({ ...saved, flow: [{ action: "wait", ms: 60_000 }] }),
			),
		).toBeNull();
		expect(evidenceRequestFromText("not json")).toBeNull();
		expect(evidenceRequestFromText("")).toBeNull();
	});

	it("captures only visible diffs unless the builder saved a plan", () => {
		expect(visiblePath("src/components/Button.tsx")).toBe(true);
		expect(visiblePath("app/globals.css")).toBe(true);
		expect(visiblePath("src/routes/settings.ts")).toBe(true);
		expect(visiblePath("src/server/db.ts")).toBe(false);
		expect(visiblePath("src/components/Button.test.tsx")).toBe(false);
		expect(visiblePath("docs/guide.mdx")).toBe(false);
		expect(visiblePath("README.md")).toBe(false);
		expect(
			evidencePlanFor({ request: null, changedPaths: ["src/server/db.ts"] }),
		).toBeNull();
		expect(
			evidencePlanFor({ request: null, changedPaths: ["src/App.tsx"] }),
		).toEqual({ version: 1, mode: "auto" });
		const cli = {
			version: 1,
			mode: "cli",
			command: "node cli --help",
		} as const;
		expect(evidencePlanFor({ request: cli, changedPaths: [] })).toBe(cli);
	});
});

describe("storage in the repository", () => {
	const label = "u-0123456789abcdef";
	it("names one hidden ref per user and pull request, never a branch", () => {
		expect(evidenceUserLabel("a".repeat(64))).toBe("u-aaaaaaaaaaaaaaaa");
		expect(() => evidenceUserLabel("not-a-digest")).toThrow();
		expect(evidenceRefName(label, 7)).toBe(
			"ytimesy/evidence/u-0123456789abcdef/pr-7",
		);
		expect(evidenceRefName(label, 7).startsWith("heads/")).toBe(false);
		expect(() => evidenceRefName(label, 0)).toThrow();
		expect(() => evidenceRefName("u-../../heads", 1)).toThrow();
		expect(
			evidenceRefPullNumber(
				"refs/ytimesy/evidence/u-0123456789abcdef/pr-12",
				label,
			),
		).toBe(12);
		for (const ref of [
			"refs/ytimesy/evidence/u-ffffffffffffffff/pr-12",
			"refs/heads/main",
			"refs/ytimesy/evidence/u-0123456789abcdef/pr-12x",
			"refs/ytimesy/evidence/u-0123456789abcdef/pr-012",
		])
			expect(evidenceRefPullNumber(ref, label)).toBeNull();
	});

	it("links files through GitHub, which applies the repository's own access rules", () => {
		expect(evidenceFileUrl("owner/app", sha, "01-home.png")).toBe(
			`https://github.com/owner/app/blob/${sha}/01-home.png?raw=true`,
		);
		for (const [repo, commit, name] of [
			["owner/app", sha, "../x.png"],
			["owner/app", sha, "a.html"],
			["owner/app/extra", sha, "a.png"],
			["owner/app", "main", "a.png"],
			["https://evil/x", sha, "a.png"],
		])
			expect(() => evidenceFileUrl(repo, commit, name)).toThrow();
	});
});

describe("Evidence section", () => {
	it("shows screenshots, the recording and how they were produced", () => {
		const section = renderEvidenceSection({
			manifest: manifest(),
			links,
			manifestUrl: `https://github.com/owner/app/blob/${"e".repeat(40)}/manifest.json?raw=true`,
			planKey: "web-abc",
			headSha: sha,
		});
		expect(section).toContain(`sha=${sha} plan=web-abc -->`);
		expect(section).toContain(
			"a clean checkout of commit `c3c0528`, the pull request head",
		);
		expect(section).toContain(`![Home](${links["01-home.png"]})`);
		expect(section).toContain(`![flow](${links["02-saved.png"]})`);
		expect(section).toContain(
			`[Screen recording](${links["recording.webm"]}) (WebM, 10 s, 2.0 MB)`,
		);
		expect(section).toContain("(HTTP 500): net::ERR");
		expect(section).toContain(
			"- Start command: `pnpm dev` (from the builder's capture plan)",
		);
		expect(section).toContain("- Flow: 2 steps, all passed");
		expect(section).toContain("2026-10-18T16:45:11Z to 2026-10-18T16:45:17Z");
		expect(section).toContain("SHA-256 of every file");
		expect(section.endsWith(EVIDENCE_END)).toBe(true);
	});

	it("does not call evidence from another commit the pull request head", () => {
		const section = renderEvidenceSection({
			manifest: manifest(),
			links,
			manifestUrl: null,
			planKey: "web-abc",
			headSha: "f".repeat(40),
		});
		expect(section).toContain(
			"Captured by the ytimesy harness from commit `c3c0528`.",
		);
	});

	it("says the app did not start and shows no images", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				status: "app-failed",
				reason:
					"The start command exited with status 1 before the app answered.",
				pages: [],
				flow: [],
				video: null,
				files: [],
			}),
			links: {},
			manifestUrl: null,
			planKey: "auto-1",
			headSha: sha,
		});
		expect(section).toContain(
			"The app did not start at commit `c3c0528`, so this pull request shows no screenshots or recording: The start command exited with status 1 before the app answered.",
		);
		expect(section).not.toContain("![");
		expect(section).not.toContain("Screen recording");
	});

	it("renders CLI output in a fence that cannot be closed early", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				kind: "cli",
				pages: [],
				flow: [],
				video: null,
				startSource: "cli",
				startCommand: "node cli --help",
				cli: { command: "node cli --help", exitCode: 0, file: "output.txt" },
			}),
			links: {},
			manifestUrl: null,
			planKey: "cli-1",
			headSha: sha,
			cliOutput: "usage: cli\n```\n# injected",
		});
		expect(section).toContain("`node cli --help` exited 0:");
		expect(section.match(/^```/gm)).toHaveLength(2);
	});

	it("replaces its own section on a new push and keeps the rest of the description", () => {
		const first = renderEvidenceSection({
			manifest: manifest(),
			links,
			manifestUrl: null,
			planKey: "web-1",
			headSha: sha,
		});
		const body = withEvidenceSection("Fixes the button.\n", first);
		expect(
			body.startsWith("Fixes the button.\n\n<!-- ytimesy-evidence:start"),
		).toBe(true);
		expect(evidenceSectionState(body)).toEqual({ sha, plan: "web-1" });
		const next = renderEvidenceSection({
			manifest: manifest({ sha: "d".repeat(40) }),
			links,
			manifestUrl: null,
			planKey: "web-2",
			headSha: "d".repeat(40),
		});
		const updated = withEvidenceSection(`${body}\n\nReviewer notes`, next);
		expect(updated.match(/ytimesy-evidence:start/g)).toHaveLength(1);
		expect(updated).toContain("Reviewer notes");
		expect(updated).toContain("Fixes the button.");
		expect(evidenceSectionState(updated)).toEqual({
			sha: "d".repeat(40),
			plan: "web-2",
		});
		expect(withEvidenceSection(null, next)).toBe(next);
	});

	it("escapes page titles and commands", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				startCommand: "echo `x` && pnpm dev",
				pages: [
					{
						url: "http://localhost:5173/",
						status: 200,
						title: "](javascript:alert(1))",
						screenshot: "01-home.png",
						error: "",
					},
				],
			}),
			links,
			manifestUrl: null,
			planKey: "web-1",
			headSha: sha,
		});
		expect(section).toContain("``echo `x` && pnpm dev``");
		expect(section).toContain("![\\]\\(javascript:alert\\(1\\)\\)]");
	});
});
