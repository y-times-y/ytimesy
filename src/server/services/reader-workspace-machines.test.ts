import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	READER_NETWORK_ISOLATION_CHECK,
	READER_NETWORK_NAMESPACE,
	SHARED_RUNTIME_PARENTS,
} from "#/domain/subagent-reader";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { commandRoot } from "./api-agent-command-tools";
import { commandScopeRoot } from "./api-command-scope";
import { writeAgentProjectSecrets } from "./project-secrets";
import { forgetPreparedReaders } from "./reader-workspace-machines";
import {
	machinesForAgentSession,
	sessionRuntimeRoot,
} from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

const vm = WorkspaceId("vm-parent");

function fakeMachines() {
	const commands: string[] = [];
	const writes: string[] = [];
	const files = new Map<string, string>([
		[PROJECT_CWD_PATH, "/home/ubuntu/repo\n"],
	]);
	const machines = {
		exec: vi.fn(async (_vm: unknown, command: string) => {
			commands.push(command);
			return { exitCode: 0, stdout: "contents", stderr: "" };
		}),
		writeTextFile: vi.fn(async (_vm: unknown, path: string) => {
			writes.push(path);
		}),
		readTextFile: vi.fn(
			async (_vm: unknown, path: string) => files.get(path) ?? null,
		),
		runCapability: vi.fn(),
		ensureRunning: vi.fn(async (id: string) => id),
	} as unknown as WorkspaceMachines;
	return { machines, commands, writes };
}

const decoded = (command: string) =>
	[...command.matchAll(/printf %s (\S+) \| base64 -d/g)].map(([, encoded]) =>
		Buffer.from(encoded, "base64").toString("utf8"),
	);

describe("read-only subagent machines", () => {
	beforeEach(() => forgetPreparedReaders());

	it("leaves the builder and writers unwrapped", async () => {
		const { machines, commands } = fakeMachines();
		await machinesForAgentSession(machines, {
			taskPlacement: "fresh",
			id: "writer",
			agentRole: "writer",
		}).exec(vm, "touch a", 1000);
		await machinesForAgentSession(machines, {
			id: "builder",
			taskPlacement: null,
		}).exec(vm, "ls", 1000);
		expect(commands[0]).toBe("touch a");
		expect(commands[1]).not.toContain("ytimesy-reader");
	});

	it("prepares the VM once, then runs every command as the reader user", async () => {
		const { machines, commands } = fakeMachines();
		const reader = machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "child-1",
			agentRole: "reviewer",
		});
		await reader.exec(vm, "git diff", 1000);
		await reader.exec(vm, "cat src/a.ts", 1000);
		const preparations = commands.filter((command) =>
			command.includes("chmod o-rw,o+x"),
		);
		expect(preparations).toHaveLength(1);
		expect(preparations[0]).toContain("'/home/ubuntu/repo'");
		const runs = commands.filter(
			(command) => !command.includes("chmod o-rw,o+x"),
		);
		expect(runs).toHaveLength(2);
		for (const run of runs)
			expect(run).toContain(
				"sudo -n -u ytimesy-reader -- env HOME=/tmp/ytimesy-agents/child-1",
			);
		expect(decoded(runs[0]).join("\n")).toContain("git diff");
		expect(reader.runCapability).toBeUndefined();
	});

	it("refuses the reader where it cannot get its own network namespace, and runs every command in one", async () => {
		const { machines, commands } = fakeMachines();
		let namespaces = false;
		vi.mocked(machines.exec).mockImplementation(async (_target, command) => {
			commands.push(command);
			if (!namespaces && command.includes(READER_NETWORK_ISOLATION_CHECK))
				return {
					exitCode: 1,
					stdout: "",
					stderr: "ytimesy: network namespaces are unavailable",
				};
			return { exitCode: 0, stdout: "contents", stderr: "" };
		});
		const reader = machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "child-1",
			agentRole: "reviewer",
		});
		await expect(reader.exec(vm, "ls", 1000)).rejects.toThrow(
			"could not be isolated",
		);
		expect(
			commands.some((command) => command.includes("ytimesy-reader --")),
		).toBe(false);
		namespaces = true;
		await reader.exec(vm, "curl http://127.0.0.1:9222/json", 1000);
		await reader.readTextFile(vm, "/etc/hostname");
		const runs = commands.filter((command) =>
			command.includes("sudo -n -u ytimesy-reader --"),
		);
		expect(runs).toHaveLength(2);
		for (const run of runs)
			expect(run.startsWith(`${READER_NETWORK_NAMESPACE} sudo -n -u`)).toBe(
				true,
			);
	});

	it("refuses runtime writes outside the scratch and hands allowed files to the reader", async () => {
		const { machines, writes, commands } = fakeMachines();
		const reader = machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "child-1",
			agentRole: "checker",
		});
		await expect(
			reader.writeTextFile(vm, "/home/ubuntu/repo/src/a.ts", "x"),
		).rejects.toThrow("cannot write");
		await expect(
			reader.writeTextFile(vm, "/var/tmp/ytimesy-secrets/agent.env", "x"),
		).rejects.toThrow("cannot write");
		expect(writes).toEqual([]);
		await reader.writeTextFile(vm, "/tmp/ytimesy-agents/child-1/notes.md", "x");
		expect(writes).toEqual(["/tmp/ytimesy-agents/child-1/notes.md"]);
		expect(commands.at(-1)).toContain(
			"sudo -n chown ytimesy-reader:ytimesy-reader '/tmp/ytimesy-agents/child-1/notes.md'",
		);
	});

	it("reads files as the reader, except its own runtime's control file", async () => {
		const { machines, commands } = fakeMachines();
		const reader = machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "child-1",
			agentRole: "researcher",
		});
		expect(await reader.readTextFile(vm, PROJECT_CWD_PATH)).toContain(
			"/home/ubuntu/repo",
		);
		expect(
			await reader.readTextFile(vm, "/var/tmp/ytimesy-secrets/agent.env"),
		).toBe("contents");
		const read = commands.at(-1) ?? "";
		expect(read).toContain("sudo -n -u ytimesy-reader");
		expect(decoded(read).join("\n")).toContain(
			"cat -- '/var/tmp/ytimesy-secrets/agent.env'",
		);
	});

	// Reproduces the checker's 0-step failure (rvcm-check1): the turn wrote the
	// project env file through the reader's machines. The secrets directory is
	// the default user's (0700), so the reader's chmod fails; were it allowed,
	// the env file is still outside what a reader may write. api-turn skips the
	// write for readers (sessionReceivesProjectSecrets).
	it("cannot write project secrets as the reader, so reader turns must not try", async () => {
		const { machines } = fakeMachines();
		// The OS's answer: the directory is the default user's, so the reader's chmod fails.
		let ownedByDefaultUser = true;
		vi.mocked(machines.exec).mockImplementation(async (_target, command) =>
			ownedByDefaultUser &&
			command.includes("ytimesy-reader") &&
			decoded(command).some((line) =>
				line.includes("install -d -m 0700 '/var/tmp/ytimesy-secrets'"),
			)
				? {
						exitCode: 1,
						stdout: "",
						stderr:
							"chmod: changing permissions of '/var/tmp/ytimesy-secrets': Operation not permitted",
					}
				: { exitCode: 0, stdout: "contents", stderr: "" },
		);
		const reader = machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "checker-1",
			agentRole: "checker",
		});
		const secrets = { envFile: "", redact: [], names: [] };
		await expect(writeAgentProjectSecrets(reader, vm, secrets)).rejects.toThrow(
			"Could not prepare project secrets in the workspace.",
		);
		// Were the reader allowed to prepare it, the env file is still not its to write.
		ownedByDefaultUser = false;
		await expect(writeAgentProjectSecrets(reader, vm, secrets)).rejects.toThrow(
			"cannot write /var/tmp/ytimesy-secrets/agent.env",
		);
	});

	// rl-live-2: the builder's first command created /tmp/ytimesy-api-commands
	// as ubuntu 0755, so the checker's `mkdir -p <its command root>` failed
	// and every bash call threw "Could not start or observe command".
	it("opens every shared runtime parent a reader's commands write under", async () => {
		const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));
		const { machines, commands } = fakeMachines();
		await machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "child-1",
			agentRole: "checker",
		}).exec(vm, "pwd", 1000);
		for (const root of [
			commandRoot("child-1"),
			commandScopeRoot("turn-1"),
			sessionRuntimeRoot("child-1"),
		]) {
			expect(SHARED_RUNTIME_PARENTS).toContain(parent(root));
			expect(commands[0]).toContain(
				`sudo -n install -d -m 1777 ${parent(root)} && sudo -n chmod 1777 ${parent(root)}`,
			);
		}
	});
});
