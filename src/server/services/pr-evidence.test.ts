import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EVIDENCE_LIMITS,
	evidenceSectionState,
	renderEvidenceSection,
} from "#/domain/pr-evidence";
import type { EvidenceGitApi } from "../adapters/github/pr-evidence-refs";
import {
	attachPullRequestEvidence,
	type EvidenceDependencies,
	evidenceUserLabelFor,
	readEvidenceBytes,
} from "./pr-evidence";

const sha = "c3c0528b5e6e62912fb34a066cf13a9fb81eb770";
const png = Buffer.from("png-bytes");
const webm = Buffer.alloc(1024 * 1024 + 5, 7);
const digest = (data: Buffer) =>
	createHash("sha256").update(data).digest("hex");

type Workspace = {
	changed: string;
	request: string;
	manifest: Record<string, unknown> | null;
	files: Record<string, Buffer>;
};

function runtime(workspace: Workspace) {
	const commands: string[] = [];
	const written = new Map<string, string>();
	return {
		commands,
		written,
		exec: vi.fn(async (_ref: string, argv: string[]) => {
			const command = argv[2] ?? "";
			commands.push(command);
			const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
			if (command.includes("diff --name-only")) return ok(workspace.changed);
			if (command.includes(".ytimesy/evidence/request.json"))
				return ok(workspace.request);
			if (command.includes("rev-parse --verify")) return ok(`${sha}\n`);
			if (command.includes("manifest.json"))
				return workspace.manifest
					? ok(JSON.stringify(workspace.manifest))
					: { exitCode: 1, stdout: "", stderr: "missing" };
			const piece = /dd if='[^']*\/out\/([^']+)' bs=(\d+) skip=(\d+)/.exec(
				command,
			);
			if (piece) {
				const data = workspace.files[piece[1]];
				const size = Number(piece[2]);
				const start = Number(piece[3]) * size;
				return ok(data.subarray(start, start + size).toString("base64"));
			}
			return ok("");
		}),
		writeTextFile: vi.fn(async (_ref: string, path: string, text: string) => {
			written.set(path, text);
		}),
		readTextFile: vi.fn(async () => null),
	};
}

function capturedManifest(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		mode: "verify",
		kind: "web",
		status: "captured",
		sha,
		clean: true,
		startCommand: "pnpm dev",
		startSource: "auto",
		urls: ["http://localhost:5173/"],
		pages: [
			{
				url: "http://localhost:5173/",
				status: 200,
				title: "Home",
				screenshot: "01-home.png",
				error: "",
			},
		],
		video: { file: "recording.webm", seconds: 6 },
		files: [
			{ name: "01-home.png", bytes: png.length, sha256: digest(png) },
			{ name: "recording.webm", bytes: webm.length, sha256: digest(webm) },
		],
		startedAt: "2026-10-18T16:45:11Z",
		finishedAt: "2026-10-18T16:45:17Z",
		...overrides,
	};
}

/** An in-memory repository for the Git Data API calls evidence makes. */
function fakeGit() {
	const blobs: Buffer[] = [];
	const trees: { path: string; sha: string }[][] = [];
	const commits: { tree: string; message: string }[] = [];
	const refs = new Map<string, string>();
	const api: EvidenceGitApi = {
		createBlob: vi.fn(async (base64: string) => {
			blobs.push(Buffer.from(base64, "base64"));
			return `blob-${blobs.length - 1}`;
		}),
		createTree: vi.fn(async (entries) => {
			trees.push(entries);
			return `tree-${trees.length - 1}`;
		}),
		createCommit: vi.fn(async (tree, message) => {
			commits.push({ tree, message });
			return String(commits.length).repeat(40).slice(0, 40);
		}),
		setRef: vi.fn(async (ref, commit) => {
			refs.set(`refs/${ref}`, commit);
		}),
		deleteRef: vi.fn(async (ref) => {
			refs.delete(`refs/${ref}`);
		}),
		listRefs: vi.fn(async (prefix) =>
			[...refs]
				.filter(([ref]) => ref.startsWith(`refs/${prefix}`))
				.map(([ref, commit]) => ({ ref, sha: commit })),
		),
		commitDate: vi.fn(async () => new Date().toISOString()),
		openPullNumbers: vi.fn(async () => new Set([7])),
	};
	/** Stored files of the latest commit, by name. */
	const stored = () => {
		const tree = trees.at(-1) ?? [];
		return Object.fromEntries(
			tree.map((entry) => [
				entry.path,
				blobs[Number(entry.sha.slice("blob-".length))],
			]),
		);
	};
	return { api, refs, commits, stored };
}

let body: string;
let headSha: string;
let git: ReturnType<typeof fakeGit>;
let deps: EvidenceDependencies & {
	git: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
};
const input = (rt: ReturnType<typeof runtime>) => ({
	userId: "eval-user",
	runtime: rt,
	providerRef: "vm",
	directory: "/home/ubuntu/app",
	revision: `refs/ytimesy/turn-commits/${"a".repeat(64)}`,
	installationId: 2,
	fullName: "owner/app",
	pullNumber: 7,
});

beforeEach(() => {
	body = "Automatic draft handoff from ytimesy.";
	headSha = sha;
	const write = vi.fn(async (next: string) => {
		body = next;
	});
	git = fakeGit();
	deps = {
		enabled: vi.fn(async () => true),
		pullRequest: vi.fn(async () => ({
			read: async () => ({ body, headSha, state: "open" }),
			write,
		})),
		git: vi.fn(async () => git.api),
		write,
	};
});

const visible: Workspace = {
	changed: "src/App.tsx\nsrc/server.ts\n",
	request: "",
	manifest: capturedManifest(),
	files: { "01-home.png": png, "recording.webm": webm },
};

describe("pull request evidence", () => {
	it("does nothing with prEvidence off", async () => {
		deps.enabled = vi.fn(async () => false);
		const rt = runtime(visible);
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "off",
		});
		expect(rt.exec).not.toHaveBeenCalled();
	});

	it("skips a diff with no visible change and no plan, without touching the PR", async () => {
		const rt = runtime({ ...visible, changed: "src/server/db.ts\n" });
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "not-visible",
		});
		expect(deps.pullRequest).not.toHaveBeenCalled();
	});

	it("captures from the pushed commit, stores hash-checked media and writes the section", async () => {
		const rt = runtime(visible);
		const outcome = await attachPullRequestEvidence(input(rt), deps);
		const stored = "1".repeat(40);
		expect(outcome).toEqual({
			kind: "updated",
			status: "captured",
			commit: stored,
		});
		const capture = rt.commands.find((command) =>
			command.includes("evidence-capture.py"),
		);
		expect(capture).toContain(" verify '/home/ubuntu/app' ");
		expect(capture).toContain(`refs/ytimesy/turn-commits/${"a".repeat(64)}`);
		expect(capture).toMatch(/^timeout --kill-after=10s 300s /);
		// The harness writes its own copy of the engine for every capture.
		const work = [...rt.written.keys()].find((path) =>
			path.endsWith("/evidence-capture.py"),
		);
		expect(work).toMatch(/^\/tmp\/ytimesy-evidence-[a-f0-9]{16}\//);
		expect(
			JSON.parse(
				rt.written.get(
					work?.replace("evidence-capture.py", "request.json") ?? "",
				) ?? "",
			),
		).toEqual({
			version: 1,
			mode: "auto",
		});
		// Stored in the pull request's own repository under a hidden per-PR ref.
		expect(deps.git).toHaveBeenCalledWith(2, "owner/app");
		const files = git.stored();
		expect(Object.keys(files)).toEqual([
			"01-home.png",
			"recording.webm",
			"manifest.json",
		]);
		expect(files["recording.webm"]).toEqual(webm);
		expect(JSON.parse(files["manifest.json"].toString()).headSha).toBe(sha);
		expect([...git.refs]).toEqual([
			[
				`refs/ytimesy/evidence/${evidenceUserLabelFor("eval-user")}/pr-7`,
				stored,
			],
		]);
		expect(git.commits[0].message).toContain("[skip ci]");
		expect(body.startsWith("Automatic draft handoff from ytimesy.\n\n")).toBe(
			true,
		);
		expect(body).toContain(
			`![Home](https://github.com/owner/app/blob/${stored}/01-home.png?raw=true)`,
		);
		expect(body).toContain("detected from package.json");
		expect(evidenceSectionState(body)?.sha).toBe(sha);
		expect(rt.commands.at(-1)).toMatch(/^rm -rf '\/tmp\/ytimesy-evidence-/);
		expect(rt.commands.at(-1)).toContain("worktree prune");
	});

	it("does not recapture the same commit and plan", async () => {
		await attachPullRequestEvidence(input(runtime(visible)), deps);
		deps.git.mockClear();
		const rt = runtime(visible);
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "unchanged",
		});
		expect(
			rt.commands.some((command) => command.includes("evidence-capture")),
		).toBe(false);
	});

	it("reports an app that did not start instead of keeping older screenshots", async () => {
		body = `Notes\n\n${renderEvidenceSection({
			manifest: {
				...capturedManifest({ sha: "e".repeat(40) }),
				reason: "",
				pages: [],
				flow: [],
				video: null,
				cli: null,
				files: [],
				dropped: [],
				linked: [],
				browser: "",
				viewport: "",
				appReadyAt: "",
				startCommand: "pnpm dev",
				urls: [],
			} as never,
			links: {},
			manifestUrl: null,
			planKey: "auto-old",
			headSha: "e".repeat(40),
		})}`;
		const rt = runtime({
			...visible,
			manifest: capturedManifest({
				status: "app-failed",
				reason:
					"The start command exited with status 1 before the app answered.",
				pages: [],
				video: null,
				files: [],
			}),
		});
		const outcome = await attachPullRequestEvidence(input(rt), deps);
		expect(outcome).toMatchObject({
			kind: "updated",
			status: "app-failed",
			commit: null,
		});
		expect(deps.git).not.toHaveBeenCalled();
		expect(body).toContain("The app did not start at commit `c3c0528`");
		expect(body).not.toContain("![");
		expect(body.match(/ytimesy-evidence:start/g)).toHaveLength(1);
		expect(body.startsWith("Notes")).toBe(true);
	});

	it("refuses a manifest that is not from the pushed commit or the PR head", async () => {
		const rt = runtime({
			...visible,
			manifest: capturedManifest({ sha: "f".repeat(40) }),
		});
		await attachPullRequestEvidence(input(rt), deps);
		expect(deps.git).not.toHaveBeenCalled();
		expect(body).toContain("did not come from the pushed commit");

		headSha = "9".repeat(40);
		body = "";
		await attachPullRequestEvidence(input(runtime(visible)), deps);
		expect(deps.git).not.toHaveBeenCalled();
		expect(body).toContain("The pull request head is now 9999999");
	});

	it("refuses a preview manifest and a missing manifest", async () => {
		await attachPullRequestEvidence(
			input(
				runtime({
					...visible,
					manifest: capturedManifest({ mode: "preview" }),
				}),
			),
			deps,
		);
		expect(deps.git).not.toHaveBeenCalled();
		expect(body).toContain("did not come from the pushed commit");
		body = "";
		await attachPullRequestEvidence(
			input(runtime({ ...visible, manifest: null })),
			deps,
		);
		expect(body).toContain("The capture tooling could not run");
	});

	it("uses the builder's saved plan even when the diff looks invisible", async () => {
		const rt = runtime({
			...visible,
			changed: "bin/cli.js\n",
			request: JSON.stringify({
				version: 1,
				mode: "cli",
				command: "node bin/cli.js --help",
			}),
			manifest: capturedManifest({
				kind: "cli",
				startSource: "cli",
				startCommand: "node bin/cli.js --help",
				pages: [],
				video: null,
				cli: {
					command: "node bin/cli.js --help",
					exitCode: 0,
					file: "output.txt",
				},
				files: [
					{
						name: "output.txt",
						bytes: 30,
						sha256: digest(Buffer.from("usage: cli token=abc123secret\n")),
					},
				],
			}),
			files: { "output.txt": Buffer.from("usage: cli token=abc123secret\n") },
		});
		await attachPullRequestEvidence(input(rt), deps);
		expect(body).toContain("`node bin/cli.js --help` exited 0:");
		expect(body).toContain("usage: cli");
		expect(Object.keys(git.stored())).toEqual(["output.txt", "manifest.json"]);
	});

	it("re-reads the pull request after capture and stops if it closed meanwhile", async () => {
		let reads = 0;
		deps.pullRequest = vi.fn(async () => ({
			read: async () => ({
				body,
				headSha,
				state: reads++ === 0 ? "open" : "closed",
			}),
			write: async (next: string) => {
				body = next;
			},
		}));
		expect(
			await attachPullRequestEvidence(input(runtime(visible)), deps),
		).toEqual({ kind: "closed" });
		expect(deps.git).not.toHaveBeenCalled();
		expect(body).toBe("Automatic draft handoff from ytimesy.");
	});
});

describe("reading media out of the workspace", () => {
	it("refuses files over their limit or changed after hashing", async () => {
		const rt = runtime(visible);
		await expect(
			readEvidenceBytes(rt, "vm", "/tmp/x/out/recording.webm", {
				name: "recording.webm",
				bytes: EVIDENCE_LIMITS.videoBytes + 1,
				sha256: "0".repeat(64),
			}),
		).rejects.toThrow("over its size limit");
		await expect(
			readEvidenceBytes(rt, "vm", "/tmp/x/out/01-home.png", {
				name: "01-home.png",
				bytes: png.length,
				sha256: "0".repeat(64),
			}),
		).rejects.toThrow("changed after capture");
		expect(
			await readEvidenceBytes(rt, "vm", "/tmp/x/out/recording.webm", {
				name: "recording.webm",
				bytes: webm.length,
				sha256: digest(webm),
			}),
		).toEqual(webm);
	});
});
