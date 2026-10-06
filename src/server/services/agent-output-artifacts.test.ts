import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import { inspectProjectSourceEvidence } from "./project-source-evidence";
import {
	readAuthorizedTaskChecks,
	readAuthorizedTaskOutput,
	requireCurrentTaskCheck,
} from "./task-output-evidence";
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

it("retains source-bound evidence and rejects accepting it after declared code changes", async () => {
	const artifacts = await fixture();
	await run("git", ["init", "-q", artifacts.root]);
	await writeFile(join(artifacts.root, "source.ts"), "export const value = 1");
	await run("git", ["-C", artifacts.root, "add", "source.ts"]);
	await run("git", [
		"-C",
		artifacts.root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-qm",
		"base",
	]);
	const workspace = {
		machines: artifacts.machines,
		vm: WorkspaceId("test"),
		cwd: artifacts.root,
	};
	await writeFile(join(artifacts.root, "source.ts"), "export const value = 2");
	const before = await inspectProjectSourceEvidence(
		workspace,
		["source.ts"],
		true,
	);
	const result = await artifacts.capture("printf 'check passed'");
	await artifacts.recordVerification(result.reference, {
		command: "printf 'check passed'",
		cwd: artifacts.root,
		before,
		after: before,
		sourcesStable: true,
	});
	const request = {
		machines: artifacts.machines,
		task: {
			id: "owner",
			userId: "owner",
			projectId: "project",
			providerRef: "test",
		} as AgentSessionRecord,
		ownerId: "owner",
		projectId: "project",
		page: { reference: result.reference, view: "summary" },
		signal: new AbortController().signal,
	};
	const current = await readAuthorizedTaskOutput(request);
	expect(() => requireCurrentTaskCheck(current)).not.toThrow();
	const failure = await artifacts.capture("printf 'warning' >&2; exit 1");
	await artifacts.recordVerification(failure.reference, {
		command: "failing check",
		cwd: artifacts.root,
		before,
		after: before,
		sourcesStable: true,
	});
	const bundleRequest = {
		...request,
		references: [result.reference, failure.reference],
	};
	const observations = vi.spyOn(artifacts.machines, "exec");
	observations.mockClear();
	const bundle = await readAuthorizedTaskChecks(bundleRequest);
	expect(observations).toHaveBeenCalledTimes(2); // One log bundle plus one fresh shared source observation.
	expect(bundle.sourceProofs).toHaveLength(1);
	expect(bundle.sourceProofs[0].sourcesCurrent).toBe(true);
	expect(bundle.checks[0]).toMatchObject({
		sourceProof: 0,
		completion: { status: 0, stopped: null },
	});
	expect(bundle.checks[1]).toMatchObject({
		sourceProof: 0,
		completion: { status: 1, stopped: null },
		stderr: {
			content: "warning",
			fullOutput: { reference: failure.reference },
		},
	});
	expect(bundle.checks[0].stdout).not.toHaveProperty("verification");
	await expect(
		readAuthorizedTaskChecks({ ...bundleRequest, ownerId: "other" }),
	).rejects.toThrow("not available");
	await expect(
		readAuthorizedTaskChecks({
			...bundleRequest,
			references: [result.reference, result.reference],
		}),
	).rejects.toThrow("distinct");
	await run("git", ["-C", artifacts.root, "add", "source.ts"]);
	await run("git", [
		"-C",
		artifacts.root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-qm",
		"publication",
	]);
	const published = await readAuthorizedTaskOutput(request);
	expect(() => requireCurrentTaskCheck(published)).not.toThrow();
	await writeFile(join(artifacts.root, "source.ts"), "export const value = 3");
	const stale = await readAuthorizedTaskOutput(request);
	const staleBundle = await readAuthorizedTaskChecks(bundleRequest);
	expect(staleBundle.sourceProofs[0].sourcesCurrent).toBe(false);
	expect(stale).toMatchObject({
		sourcesCurrent: false,
		completion: { status: 0 },
	});
	expect(() => requireCurrentTaskCheck(stale)).toThrow("current unchanged");
	for (const evidence of [
		{},
		{ ...current, completion: { status: 1, stopped: null } },
		{ ...current, completion: { status: 0, stopped: "timeout" } },
	])
		expect(() => requireCurrentTaskCheck(evidence)).toThrow();
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

it("retains actual foreground completion with both output streams for later leader review", async () => {
	const artifacts = await fixture();
	for (const exitCode of [0, 2]) {
		const result = await artifacts.capture(`exit ${exitCode}`);
		for (const stream of ["stdout", "stderr"] as const) {
			expect(
				await readAuthorizedTaskOutput({
					machines: artifacts.machines,
					task: {
						id: "owner",
						userId: "owner",
						projectId: "project",
						providerRef: "test",
					} as AgentSessionRecord,
					ownerId: "owner",
					projectId: "project",
					page: { reference: result.reference, stream, background: false },
					signal: new AbortController().signal,
				}),
			).toMatchObject({
				completion: { status: exitCode, stopped: null },
			});
		}
	}
});
