import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	apiTurnFailureClassification,
	apiTurnFailureMessage,
} from "#/domain/api-turn-failure";
import { posixShellCommand } from "#/domain/posix-command";
import { verifyCompletedRepository } from "./completion-verification";

const records = vi.hoisted(() => ({
	find: vi.fn(),
	save: vi.fn(),
	claim: vi.fn(),
	base: "",
}));
vi.mock("../adapters/turn-verification", () => ({
	findCompletedVerification: records.find,
	readVerificationBaseline: async () => records.base,
	recordCompletedVerification: records.save,
}));
vi.mock("../adapters/agent-task-command-receipts", () => ({
	claimAgentTaskCommand: records.claim,
	completeAgentTaskCommand: vi.fn(async () => {}),
	renewAgentTaskCommandClaim: vi.fn(async () => {}),
}));
// Git and process output are real here; the existing Linux-only PID fence is tested separately.
vi.mock("./api-command-scope", () => ({
	scopedShellCommand: (input: { cwd: string; command: string }) =>
		`cd ${posixShellCommand([input.cwd])} && ${input.command}`,
	stopApiTurnCommands: vi.fn(async () => {}),
}));
const run = promisify(execFile);

// Every test builds and verifies real git repositories; slow under a loaded
// full-suite run.
vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
beforeEach(() => {
	records.find.mockReset().mockResolvedValue(null);
	records.save.mockReset().mockResolvedValue(undefined);
	records.claim.mockReset().mockResolvedValue({ kind: "claimed" });
});
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(
	check = "if (require('node:fs').readFileSync('source.txt','utf8') !== 'fixed\\n') process.exit(7);",
	configuredChecks = true,
) {
	const scratch = await mkdtemp(join(tmpdir(), "yt-completion-"));
	roots.push(scratch);
	const directory = join(scratch, "repo");
	await mkdir(join(directory, ".ytimesy"), { recursive: true });
	await run("git", ["init", "-q", directory]);
	if (configuredChecks)
		await writeFile(
			join(directory, ".ytimesy/environment.json"),
			JSON.stringify({ checks: ["node check.cjs"] }),
		);
	await writeFile(join(directory, "check.cjs"), check);
	await writeFile(join(directory, "source.txt"), "initial\n");
	await run("git", ["-C", directory, "add", "."]);
	await run("git", [
		"-C",
		directory,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"baseline",
	]);
	await run("git", [
		"-C",
		directory,
		"update-ref",
		"refs/ytimesy/base",
		"HEAD",
	]);
	records.base = (
		await run("git", ["-C", directory, "rev-parse", "HEAD"])
	).stdout.trim();
	await writeFile(join(directory, "source.txt"), "fixed\n");
	const commands: string[][] = [];
	const runtime = {
		exec: async (_vm: string, argv: string[]) => {
			commands.push(argv);
			const [binary, ...args] = argv.map((value) =>
				value.replaceAll("/tmp/ytimesy-output-", `${scratch}/output-`),
			);
			try {
				return { ...(await run(binary, args)), exitCode: 0 };
			} catch (error) {
				const failure = error as {
					stdout: string;
					stderr: string;
					code: number;
				};
				return { ...failure, exitCode: failure.code };
			}
		},
	};
	return {
		runtime,
		directory,
		commands,
		userId: "owner",
		sessionId: randomUUID(),
		providerRef: "fixture",
		turn: "a".repeat(64),
	};
}

it("reports missing baseline verification policy instead of suggesting a Git authentication fix", async () => {
	const input = await fixture(undefined, false);
	let failure: unknown;
	try {
		await verifyCompletedRepository(input);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect(apiTurnFailureClassification(failure)).toMatchObject({
		name: "VerificationPolicyFailure",
		reason: "missing-checks",
	});
	expect(apiTurnFailureMessage("commit", failure)).toContain(
		"Configure project verification checks",
	);
	expect(apiTurnFailureMessage("commit", failure)).not.toContain(
		"GitHub access",
	);
	expect(records.claim).not.toHaveBeenCalled();
	expect(records.save).not.toHaveBeenCalled();
});

it("selects baseline commands, retains real completion references and reuses only the exact full tree", async () => {
	const input = await fixture();
	const first = await verifyCompletedRepository(input);
	expect(first.status).toBe("verified");
	if (first.status !== "verified") throw new Error("Missing verification");
	expect(first.receipt.checks.map((check) => check.command)).toEqual([
		"git diff --check && git diff --cached --check",
		"node check.cjs",
	]);
	expect(records.save).toHaveBeenCalledExactlyOnceWith(
		"owner",
		input.sessionId,
		first.receipt,
	);
	records.find.mockResolvedValue(first.receipt);
	input.commands.length = 0;
	expect((await verifyCompletedRepository(input)).status).toBe("verified");
	expect(input.commands).toHaveLength(2);
	expect(input.commands.every((argv) => argv[0] === "python3")).toBe(true);
	await writeFile(join(input.directory, "new-untracked.txt"), "new\n");
	records.find.mockImplementation(
		async (_owner, _session, _directory, snapshot) =>
			snapshot.tree === first.receipt.tree ? first.receipt : null,
	);
	await verifyCompletedRepository(input);
	expect(records.save).toHaveBeenCalledTimes(2);
});

it("never saves a verification receipt for failed baseline checks", async () => {
	const input = await fixture("process.exit(7)");
	await expect(verifyCompletedRepository(input)).rejects.toThrow("exit 7");
	expect(records.save).not.toHaveBeenCalled();
	expect(await readFile(join(input.directory, "source.txt"), "utf8")).toBe(
		"fixed\n",
	);
});

it("reuses server integration capture once while retaining the whole-tree gate", async () => {
	const input = await fixture();
	const executeCheck = vi.fn(async (command: string) => {
		await run("bash", [
			"-lc",
			`cd ${posixShellCommand([input.directory])} && ${command}`,
		]);
		return {
			command,
			reference: randomUUID(),
			exitCode: 0 as const,
			stopped: null,
		};
	});
	const first = await verifyCompletedRepository({ ...input, executeCheck });
	expect(first.status).toBe("verified");
	if (first.status !== "verified") throw new Error("Missing verification");
	expect(executeCheck).toHaveBeenCalledTimes(2);
	records.find.mockResolvedValue(first.receipt);
	await verifyCompletedRepository(input);
	expect(executeCheck).toHaveBeenCalledTimes(2);
	expect(input.commands.every((argv) => argv[0] === "python3")).toBe(true);
});

it("rejects invalid server executor receipts and new undeclared changes", async () => {
	const input = await fixture();
	await expect(
		verifyCompletedRepository({
			...input,
			executeCheck: async () => ({
				command: "different",
				reference: randomUUID(),
				exitCode: 0,
				stopped: null,
			}),
		}),
	).rejects.toThrow("different command");
	expect(records.save).not.toHaveBeenCalled();
	await expect(
		verifyCompletedRepository({
			...input,
			executeCheck: async (command) => {
				await writeFile(join(input.directory, "unlisted.txt"), "new");
				return { command, reference: randomUUID(), exitCode: 0, stopped: null };
			},
		}),
	).rejects.toThrow("Checkout changed during");
	expect(records.save).not.toHaveBeenCalled();
});

it("rejects changes to undeclared or new sources during verification", async () => {
	const input = await fixture(
		"require('node:fs').writeFileSync('previously-undeclared.txt', 'mutation');",
	);
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"Checkout changed during",
	);
	expect(records.save).not.toHaveBeenCalled();
});

it("does not execute changed verification policy or invent checks for an unconfigured baseline", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, ".ytimesy/environment.json"),
		JSON.stringify({ checks: ["true"] }),
	);
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"separately approved baseline",
	);
	expect(input.commands).toHaveLength(1);
	expect(records.save).not.toHaveBeenCalled();
});

it("treats unchanged work as unchanged, not passing verification", async () => {
	const input = await fixture();
	await writeFile(join(input.directory, "source.txt"), "initial\n");
	expect(await verifyCompletedRepository(input)).toMatchObject({
		status: "unchanged",
	});
	expect(records.save).not.toHaveBeenCalled();
});

it("allows dependency metadata edits without accepting redefined check scripts", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, "package.json"),
		JSON.stringify({ dependencies: { example: "1.0.0" } }),
	);
	await writeFile(
		join(input.directory, "package-lock.json"),
		JSON.stringify({ lockfileVersion: 3 }),
	);
	expect((await verifyCompletedRepository(input)).status).toBe("verified");
	await writeFile(
		join(input.directory, "package.json"),
		JSON.stringify({ scripts: { test: "true" } }),
	);
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"Verification command policy changed",
	);
	expect(records.save).toHaveBeenCalledTimes(1);
});

it("requires a saved baseline and respects cancellation before guest execution", async () => {
	const input = await fixture();
	const abort = new AbortController();
	abort.abort();
	await expect(
		verifyCompletedRepository({ ...input, signal: abort.signal }),
	).rejects.toThrow();
	expect(input.commands).toHaveLength(0);
	await run("git", [
		"-C",
		input.directory,
		"update-ref",
		"-d",
		"refs/ytimesy/base",
	]);
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"cannot establish",
	);
	expect(records.save).not.toHaveBeenCalled();
});

it("does not execute commands without a control-plane baseline or replay uncertain attempts", async () => {
	const input = await fixture();
	const base = records.base;
	records.base = "";
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"server-owned verification baseline",
	);
	expect(input.commands).toHaveLength(0);
	records.base = base;
	records.claim.mockResolvedValue({ kind: "processing" });
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"not replayed",
	);
	expect(input.commands).toHaveLength(1);
	expect(records.save).not.toHaveBeenCalled();
});

it("rejects a guest-redefined baseline even when its new commit is pristine", async () => {
	const input = await fixture();
	await run("git", ["-C", input.directory, "add", "."]);
	await run("git", [
		"-C",
		input.directory,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"redefined",
	]);
	await run("git", [
		"-C",
		input.directory,
		"update-ref",
		"refs/ytimesy/base",
		"HEAD",
	]);
	await expect(verifyCompletedRepository(input)).rejects.toThrow(
		"cannot establish",
	);
	expect(records.save).not.toHaveBeenCalled();
});
