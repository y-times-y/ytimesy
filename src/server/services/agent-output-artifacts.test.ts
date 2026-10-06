import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
		exec: async (_vm: string, command: string) => {
			const result = await run("bash", [
				"-lc",
				command.replaceAll("/tmp/ytimesy-output-", `${root}/output-`),
			]);
			return { ...result, exitCode: 0 };
		},
	} as unknown as WorkspaceMachines;
	return agentOutputArtifacts({
		machines,
		vm: WorkspaceId("test"),
		cwd: root,
		sessionId,
		signal: new AbortController().signal,
	});
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
	expect(await artifacts.capture("sleep 5", 1)).toMatchObject({
		exitCode: 124,
		stopped: "timeout",
	});
});
