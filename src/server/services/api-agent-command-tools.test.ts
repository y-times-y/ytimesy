import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { apiAgentCommandTools } from "./api-agent-command-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const roots: string[] = [];
const commandRoots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
	await Promise.all(
		commandRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(readOnly = false) {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-command-tools-"));
	roots.push(root);
	const commands: string[] = [];
	const machines = {
		exec: async (_vm: string, command: string) => {
			commands.push(command);
			try {
				const output = await run("bash", ["-lc", command]);
				return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
			} catch (error) {
				const failed = error as Error & {
					code: number;
					stdout: string;
					stderr: string;
				};
				return {
					exitCode: failed.code,
					stdout: failed.stdout,
					stderr: failed.stderr,
				};
			}
		},
	} as unknown as WorkspaceMachines;
	const sessionId = crypto.randomUUID();
	commandRoots.push(`/tmp/ytimesy-api-commands/${sessionId}`);
	const tools = apiAgentCommandTools({
		machines,
		vm: WorkspaceId("test-vm"),
		cwd: root,
		sessionId,
		readOnly,
		signal: new AbortController().signal,
		once: async (_id, execute) => execute(),
	});
	return { tools, commands };
}

async function call(tool: unknown, input: object) {
	return (
		tool as { execute: (args: object, options: object) => Promise<unknown> }
	).execute(input, { toolCallId: crypto.randomUUID() });
}

it("keeps long-running commands out of the read-only lead", async () => {
	const { tools } = await fixture(true);
	expect(Object.keys(tools)).toEqual(["read_command"]);
});

it.runIf(process.platform === "linux")(
	"runs and polls a command in an isolated tmux session",
	async () => {
		const { tools } = await fixture();
		const started = (await call(tools.start_command, {
			command: "printf 'command-complete\\n'",
			maxSeconds: 30,
		})) as { id: string };
		let output = "";
		for (let attempt = 0; attempt < 20; attempt++) {
			output = (await call(tools.read_command, { id: started.id })) as string;
			if (output.includes("STATUS=0")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(output).toContain("STATUS=0");
		expect(output).toContain("command-complete");
	},
);
