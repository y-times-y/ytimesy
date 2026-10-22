import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { captureConversationCode } from "./conversation-code-checkpoint";
import { establishVerificationBaselines } from "./verification-baseline";

vi.mock("../adapters/turn-verification", () => ({
	readVerificationBaseline: async () => null,
	pinVerificationBaseline: async () => {},
}));

const run = promisify(execFile);
let root = "";
let repo = "";
const git = (...args: string[]) => run("git", ["-C", repo, ...args]);

// The real scripts, run on this machine as the VM would run them.
const local: AgentToolWorkspace = {
	vm: WorkspaceId("local"),
	cwd: "",
	machines: {
		exec: async (_vm: unknown, command: string) => {
			try {
				const { stdout, stderr } = await run("sh", ["-c", command], {
					maxBuffer: 1 << 24,
				});
				return { exitCode: 0, stdout, stderr };
			} catch (error) {
				const failed = error as {
					code?: number;
					stdout?: string;
					stderr?: string;
				};
				return {
					exitCode: failed.code ?? 1,
					stdout: failed.stdout ?? "",
					stderr: failed.stderr ?? "",
				};
			}
		},
	} as unknown as AgentToolWorkspace["machines"],
};

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ytimesy-code-point-"));
	repo = join(root, "repo");
	await run("git", ["init", "-q", repo]);
	await git("config", "user.email", "t@example.com");
	await git("config", "user.name", "t");
	await Promise.all(
		Array.from({ length: 400 }, (_, index) =>
			writeFile(join(repo, `file-${index}.txt`), `content ${index}\n`),
		),
	);
	await git("add", "-A");
	await git("commit", "-q", "-m", "base");
	await git("update-ref", "refs/ytimesy/base", "HEAD");
	local.cwd = repo;
}, 60_000);
afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

async function touchAll(at: Date) {
	await Promise.all(
		Array.from({ length: 400 }, (_, index) =>
			utimes(join(repo, `file-${index}.txt`), at, at),
		),
	);
}

it("checks the baseline without locking or rewriting the index the code point's write-tree needs", async () => {
	// Stat-dirty files: a plain `git status` would refresh the index under
	// index.lock, and a git write-tree at that moment fails outright.
	await touchAll(new Date(Date.now() + 60_000));
	const index = join(repo, ".git", "index");
	const before = (await stat(index)).mtimeMs;
	await new Promise((resolve) => setTimeout(resolve, 20));
	await establishVerificationBaselines({
		...local,
		userId: "owner",
		sessionId: "chat",
	});
	expect((await stat(index)).mtimeMs).toBe(before);
});

it("takes the code point while the baselines' pristine check runs, every time", async () => {
	for (let round = 0; round < 15; round++) {
		// Fresh file times make the status check want to refresh the index,
		// as on a just-copied VM.
		await touchAll(new Date(Date.now() + 120_000 + round * 1000));
		const [, captured] = await Promise.all([
			establishVerificationBaselines({
				...local,
				userId: "owner",
				sessionId: "chat",
			}),
			captureConversationCode(local, `refs/ytimesy/recovery/round-${round}`),
		]);
		expect(captured.head).toBe((await git("rev-parse", "HEAD")).stdout.trim());
	}
}, 120_000);
