import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(sessionId = "owner") {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-output-test-"));
	roots.push(root);
	const machines = {
		ensureRunning: async () => {},
		exec: async (_vm: string, command: string) => {
			const result = await run("bash", [
				"-lc",
				command.replaceAll("/tmp/ytimesy-output-", `${root}/output-`),
			]);
			return { ...result, exitCode: 0 };
		},
	} as unknown as WorkspaceMachines;
	const artifacts = agentOutputArtifacts({
		machines,
		vm: WorkspaceId("test"),
		cwd: root,
		sessionId,
		signal: new AbortController().signal,
	});
	return {
		...artifacts,
		root,
		machines,
		physicalDirectory: artifacts.directory.replace(
			"/tmp/ytimesy-output-",
			`${root}/output-`,
		),
	};
}

it("retains complete Unicode output and stderr behind bounded session-owned pages", async () => {
	const artifacts = await fixture();
	const result = await artifacts.capture(
		'python3 -c \'import sys; print("你" * 32010, end=""); print("error", file=sys.stderr)\' ',
	);
	expect(result.stdout).toBe("你".repeat(32000));
	expect(result.stderr).toBe("error\n");
	expect(result.stdoutNextStart).toBe(32000);
	const page = await artifacts.readTool.execute?.(
		{ reference: result.reference, stream: "stdout", start: 32000 },
		{ toolCallId: "read", messages: [], context: {} },
	);
	expect(page).toMatchObject({ content: "你".repeat(10), nextStart: null });
	await expect(
		artifacts.readTool.execute?.(
			{ reference: "../private", stream: "stdout", start: 0 },
			{ toolCallId: "bad", messages: [], context: {} },
		),
	).rejects.toThrow();
});

it("reports no matches separately from a failed command and stops timed-out execution", async () => {
	const artifacts = await fixture();
	expect((await artifacts.capture("exit 1")).exitCode).toBe(1);
	const timedOut = await artifacts.capture("sleep 5", 1);
	expect(timedOut).toMatchObject({
		exitCode: 124,
		stopped: "timeout",
	});
	expect(await artifacts.read({ reference: timedOut.reference })).toMatchObject(
		{
			completion: { status: 124, stopped: "timeout" },
		},
	);
});

it("summarizes complete retained output without hiding omissions, failure or recovery", async () => {
	const artifacts = await fixture();
	const result = await artifacts.capture(
		'python3 -c \'import sys; print("你" * 40000, end=""); print("failed", file=sys.stderr); sys.exit(2)\'',
	);
	const summary = await artifacts.read({
		reference: result.reference,
		view: "summary",
	});
	expect(summary).toMatchObject({
		view: "summary",
		content: "你".repeat(2000),
		characters: 40000,
		omittedCharacters: 38000,
		contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		completion: { status: 2, stopped: null },
	});
	if (!summary.fullOutput)
		throw new Error("Summary must retain its full-output pointer");
	expect(await artifacts.read(summary.fullOutput)).toMatchObject({
		content: "你".repeat(32000),
		nextStart: 32000,
	});
	expect(
		await artifacts.read({
			reference: result.reference,
			stream: "stderr",
			view: "summary",
		}),
	).toMatchObject({ content: "failed\n", omittedCharacters: 0 });
	await expect(
		artifacts.read({ reference: result.reference, view: "summary", start: 1 }),
	).rejects.toThrow();
});

it("does not invent success for legacy captures or malformed completion receipts", async () => {
	const artifacts = await fixture();
	const result = await artifacts.capture("exit 0");
	const receipt = join(
		artifacts.physicalDirectory,
		`${result.reference}.receipt.json`,
	);
	await rm(receipt);
	expect(
		await artifacts.read({ reference: result.reference }),
	).not.toHaveProperty("completion");
	await writeFile(receipt, JSON.stringify({ exitCode: true, stopped: null }));
	await expect(
		artifacts.read({ reference: result.reference }),
	).rejects.toThrow();
});
