import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EVIDENCE_LIMITS,
	evidenceSectionState,
	renderEvidenceSection,
} from "#/domain/pr-evidence";
import {
	type EvidenceStore,
	evidenceCapturePrefix,
} from "../adapters/pr-evidence-store";
import {
	attachPullRequestEvidence,
	type EvidenceDependencies,
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

const projectId = "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const evidenceId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const scope = { userId: "eval-user", projectId };

/** Private object storage in memory. */
function fakeStore() {
	const objects = new Map<string, { data: Buffer; contentType: string }>();
	const store: EvidenceStore & {
		put: ReturnType<typeof vi.fn>;
		removePrefix: ReturnType<typeof vi.fn>;
	} = {
		put: vi.fn(async (key: string, data: Uint8Array, contentType: string) => {
			objects.set(key, { data: Buffer.from(data), contentType });
		}),
		get: vi.fn(async () => new Response(null, { status: 404 })),
		removePrefix: vi.fn(async (prefix: string) => {
			let removed = 0;
			for (const key of [...objects.keys()])
				if (key.startsWith(prefix)) {
					objects.delete(key);
					removed++;
				}
			return removed;
		}),
	};
	/** Stored files of one capture, by name. */
	const files = (id = evidenceId) => {
		const prefix = evidenceCapturePrefix(scope, id);
		return Object.fromEntries(
			[...objects]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, value]) => [key.slice(prefix.length), value]),
		);
	};
	return { store, objects, files };
}

function fakeRecords() {
	return {
		insert: vi.fn(async () => undefined),
		finish: vi.fn(async () => undefined),
		superseded: vi.fn(
			async () => [] as { id: string; userId: string; projectId: string }[],
		),
		remove: vi.fn(async () => 0),
	};
}

let body: string;
let headSha: string;
let storage: ReturnType<typeof fakeStore>;
let records: ReturnType<typeof fakeRecords>;
let deps: EvidenceDependencies & { write: ReturnType<typeof vi.fn> };
const input = (rt: ReturnType<typeof runtime>) => ({
	userId: "eval-user",
	projectId,
	sessionId: "5d2a8f1c-3b4e-4c6d-9e0f-1a2b3c4d5e6f",
	runtime: rt,
	providerRef: "vm",
	directory: "/home/ubuntu/app",
	revision: `refs/ytimesy/turn-commits/${"a".repeat(64)}`,
	installationId: 2,
	fullName: "owner/app",
	pullNumber: 7,
});
const pageUrl = `https://app.ytimesy.test/projects/${projectId}/evidence/${evidenceId}`;

beforeEach(() => {
	body = "Automatic draft handoff from ytimesy.";
	headSha = sha;
	const write = vi.fn(async (next: string) => {
		body = next;
	});
	storage = fakeStore();
	records = fakeRecords();
	deps = {
		enabled: vi.fn(async () => true),
		pullRequest: vi.fn(async () => ({
			read: async () => ({ body, headSha, state: "open" }),
			write,
		})),
		store: () => storage.store,
		records,
		appUrl: () => "https://app.ytimesy.test",
		newId: () => evidenceId,
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
	it("does nothing with prEvidence off or without private storage", async () => {
		deps.enabled = vi.fn(async () => false);
		const rt = runtime(visible);
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "off",
		});
		deps.enabled = vi.fn(async () => true);
		deps.store = () => null;
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "no-storage",
		});
		expect(rt.exec).not.toHaveBeenCalled();
		expect(deps.pullRequest).not.toHaveBeenCalled();
	});

	it("skips a diff with no visible change and no plan, without touching the PR", async () => {
		const rt = runtime({ ...visible, changed: "src/server/db.ts\n" });
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "not-visible",
		});
		expect(deps.pullRequest).not.toHaveBeenCalled();
		expect(records.insert).not.toHaveBeenCalled();
	});

	it("captures from the pushed commit, stores hash-checked media privately and links the page", async () => {
		const rt = runtime(visible);
		const outcome = await attachPullRequestEvidence(input(rt), deps);
		expect(outcome).toEqual({
			kind: "updated",
			status: "captured",
			evidenceId,
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
		// A row first (the chat shows it capturing), then the verified result.
		expect(records.insert).toHaveBeenCalledWith(
			expect.objectContaining({
				id: evidenceId,
				userId: "eval-user",
				projectId,
				sessionId: "5d2a8f1c-3b4e-4c6d-9e0f-1a2b3c4d5e6f",
				fullName: "owner/app",
				pullNumber: 7,
				commitSha: sha,
				kind: "web",
			}),
		);
		const stored = storage.files();
		expect(Object.keys(stored)).toEqual(["01-home.png", "recording.webm"]);
		expect(stored["recording.webm"].data).toEqual(webm);
		expect(stored["recording.webm"].contentType).toBe("video/webm");
		expect([...storage.objects.keys()][0]).toMatch(
			/^pr-evidence\/[a-f0-9]{64}\/[a-f0-9]{64}\/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\/01-home\.png$/,
		);
		expect(records.finish).toHaveBeenCalledWith("eval-user", evidenceId, {
			manifest: expect.objectContaining({ status: "captured", sha }),
			headSha: sha,
			files: [
				{ name: "01-home.png", bytes: png.length, sha256: digest(png) },
				{ name: "recording.webm", bytes: webm.length, sha256: digest(webm) },
			],
		});
		// Nothing in the repository: only the description changes, with a link.
		expect(body.startsWith("Automatic draft handoff from ytimesy.\n\n")).toBe(
			true,
		);
		expect(body).toContain(`[View the evidence](${pageUrl})`);
		expect(body).toContain(": 1 screenshot, 6 s screen recording.");
		expect(body).toContain("6 s screen recording");
		expect(body).not.toContain("![");
		expect(evidenceSectionState(body)?.sha).toBe(sha);
		expect(records.superseded).toHaveBeenCalled();
		expect(rt.commands.at(-1)).toMatch(/^rm -rf '\/tmp\/ytimesy-evidence-/);
		expect(rt.commands.at(-1)).toContain("worktree prune");
	});

	it("removes captures beyond the newest few of the pull request", async () => {
		const old = "11111111-2222-4333-8444-555555555555";
		await storage.store.put(
			`${evidenceCapturePrefix(scope, old)}01-home.png`,
			png,
			"image/png",
		);
		records.superseded.mockResolvedValue([{ id: old, ...scope }]);
		await attachPullRequestEvidence(input(runtime(visible)), deps);
		expect(storage.files(old)).toEqual({});
		expect(records.remove).toHaveBeenCalledWith([old]);
		expect(Object.keys(storage.files())).toHaveLength(2);
	});

	it("does not recapture the same commit and plan", async () => {
		await attachPullRequestEvidence(input(runtime(visible)), deps);
		records.insert.mockClear();
		const rt = runtime(visible);
		expect(await attachPullRequestEvidence(input(rt), deps)).toEqual({
			kind: "unchanged",
		});
		expect(
			rt.commands.some((command) => command.includes("evidence-capture")),
		).toBe(false);
		expect(records.insert).not.toHaveBeenCalled();
	});

	it("reports an app that did not start instead of keeping older evidence", async () => {
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
			planKey: "auto-old",
			headSha: "e".repeat(40),
			pageUrl: "https://app.ytimesy.test/old",
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
		expect(outcome).toMatchObject({ kind: "updated", status: "app-failed" });
		expect(storage.store.put).not.toHaveBeenCalled();
		expect(records.finish).toHaveBeenCalledWith(
			"eval-user",
			evidenceId,
			expect.objectContaining({ files: [] }),
		);
		expect(body).toContain("The app did not start at commit `c3c0528`");
		expect(body).not.toContain("https://app.ytimesy.test/old");
		expect(body.match(/ytimesy-evidence:start/g)).toHaveLength(1);
		expect(body.startsWith("Notes")).toBe(true);
	});

	it("refuses a manifest that is not from the pushed commit or the PR head", async () => {
		const rt = runtime({
			...visible,
			manifest: capturedManifest({ sha: "f".repeat(40) }),
		});
		await attachPullRequestEvidence(input(rt), deps);
		expect(storage.store.put).not.toHaveBeenCalled();
		expect(body).toContain("did not come from the pushed commit");

		headSha = "9".repeat(40);
		body = "";
		await attachPullRequestEvidence(input(runtime(visible)), deps);
		expect(storage.store.put).not.toHaveBeenCalled();
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
		expect(storage.store.put).not.toHaveBeenCalled();
		expect(body).toContain("did not come from the pushed commit");
		body = "";
		await attachPullRequestEvidence(
			input(runtime({ ...visible, manifest: null })),
			deps,
		);
		expect(body).toContain("The capture tooling could not run");
	});

	it("uses the builder's saved plan even when the diff looks invisible, and redacts CLI output", async () => {
		const output = Buffer.from(
			"usage: cli\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n",
		);
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
					{ name: "output.txt", bytes: output.length, sha256: digest(output) },
				],
			}),
			files: { "output.txt": output },
		});
		await attachPullRequestEvidence(input(rt), deps);
		expect(records.insert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "cli" }),
		);
		const stored = storage.files();
		expect(Object.keys(stored)).toEqual(["output.txt"]);
		expect(stored["output.txt"].data.toString()).toContain("usage: cli");
		expect(stored["output.txt"].data.toString()).not.toContain(
			"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
		);
		expect(body).toContain("CLI output");
		expect(body).not.toContain("usage: cli");
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
		expect(storage.store.put).not.toHaveBeenCalled();
		expect(records.remove).toHaveBeenCalledWith([evidenceId]);
		expect(body).toBe("Automatic draft handoff from ytimesy.");
	});

	it("leaves no half-stored media when storage fails, and reports the capture failed", async () => {
		storage.store.put.mockImplementationOnce(async (key: string, data) => {
			storage.objects.set(key, { data: Buffer.from(data), contentType: "" });
		});
		storage.store.put.mockRejectedValueOnce(
			new Error("R2 upload failed (500)."),
		);
		await expect(
			attachPullRequestEvidence(input(runtime(visible)), deps),
		).rejects.toThrow("R2 upload failed");
		expect(storage.files()).toEqual({});
		expect(records.finish).toHaveBeenCalledWith("eval-user", evidenceId, {
			manifest: expect.objectContaining({
				status: "tooling-failed",
				reason: "Storing the capture failed.",
			}),
			headSha: null,
			files: [],
		});
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
