import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	AGENT_SECRETS_ENV_PATH,
	PROJECT_SECRETS_PREPARATION_FAILED,
	ProjectSecretsPreparationFailure,
} from "#/domain/project-secret";
import {
	AGENT_SECRETS_SETUP_BUDGETS_MS,
	writeAgentProjectSecrets,
} from "./project-secrets";
import type { WorkspaceMachines } from "./workspace-machines";

const vm = WorkspaceId("vm-1");
const secrets = { envFile: "DATABASE_URL=x\n", redact: ["x"], names: [] };

function machines(exitCodeFor: (command: string) => number) {
	const commands: string[] = [];
	const writes: string[] = [];
	const fake = {
		exec: vi.fn(async (_vm: WorkspaceId, command: string) => {
			commands.push(command);
			return { exitCode: exitCodeFor(command), stdout: "", stderr: "" };
		}),
		writeTextFile: vi.fn(async (_vm: WorkspaceId, path: string) => {
			writes.push(path);
		}),
	} as unknown as WorkspaceMachines;
	return { fake, commands, writes };
}

// The provider writes files as root; commands run as the default user, so a
// root-owned 0600 file was skipped by every command (found on dev 2026-10-30).
it("hands the env file to the command user and checks it can read it", async () => {
	const { fake, commands, writes } = machines(() => 0);
	await writeAgentProjectSecrets(fake, vm, secrets);
	expect(writes).toEqual([AGENT_SECRETS_ENV_PATH]);
	const owned = commands.at(-1) ?? "";
	expect(owned).toContain('sudo -n chown "$(id -u):$(id -g)"');
	expect(owned).toContain(`[ -r '${AGENT_SECRETS_ENV_PATH}' ]`);
});

it("fails the turn's preparation when the file stays unreadable", async () => {
	const { fake } = machines((command) => (command.includes("chown") ? 1 : 0));
	await expect(writeAgentProjectSecrets(fake, vm, secrets)).rejects.toThrow(
		PROJECT_SECRETS_PREPARATION_FAILED,
	);
});

it("retries only timed-out idempotent setup operations before writing", async () => {
	vi.useFakeTimers();
	try {
		for (const phase of ["directory", "ownership"]) {
			let attempts = 0;
			const { fake, commands, writes } = machines((command) => {
				const target =
					phase === "ownership"
						? command.includes("chown")
						: command.includes("install -d");
				return target && ++attempts < 3 ? 124 : 0;
			});
			const check = expect(
				writeAgentProjectSecrets(fake, vm, secrets),
			).resolves.toBeUndefined();
			await vi.runAllTimersAsync();
			await check;
			expect(attempts).toBe(3);
			expect(writes).toEqual([AGENT_SECRETS_ENV_PATH]);
			expect(commands.length).toBeGreaterThan(3);
		}
	} finally {
		vi.useRealTimers();
	}
});

it("bounds persistent setup timeouts and never writes secrets when the private directory is unconfirmed", async () => {
	vi.useFakeTimers();
	try {
		const { fake, commands, writes } = machines(() => 124);
		const check = expect(
			writeAgentProjectSecrets(fake, vm, secrets),
		).rejects.toMatchObject({
			name: "ProjectSecretsPreparationFailure",
			phase: "directory",
			failure: { kind: "timeout" },
		});
		await vi.runAllTimersAsync();
		await check;
		expect(commands).toHaveLength(3);
		expect(writes).toHaveLength(0);
	} finally {
		vi.useRealTimers();
	}
});

it("does not retry private-directory refusals or retain their command output", async () => {
	const { fake, writes } = machines(() => 1);
	vi.mocked(fake.exec).mockResolvedValue({
		exitCode: 1,
		stdout: "private-setup-output",
		stderr: "private-setup-output",
	});
	const failure = await writeAgentProjectSecrets(fake, vm, secrets).catch(
		(e: unknown) => e,
	);
	expect(failure).toBeInstanceOf(ProjectSecretsPreparationFailure);
	expect(JSON.stringify(failure)).not.toContain("private-setup-output");
	expect(fake.exec).toHaveBeenCalledTimes(1);
	expect(writes).toHaveLength(0);
});

it("gives each retry of a timed-out setup command a longer budget", async () => {
	vi.useFakeTimers();
	try {
		let attempts = 0;
		const { fake } = machines((command) =>
			command.includes("install -d") && ++attempts < 3 ? 124 : 0,
		);
		const done = writeAgentProjectSecrets(fake, vm, secrets);
		await vi.runAllTimersAsync();
		await done;
		const budgets = vi
			.mocked(fake.exec)
			.mock.calls.filter(([, command]) => command.includes("install -d"))
			.map(([, , budget]) => budget);
		expect(budgets).toEqual([...AGENT_SECRETS_SETUP_BUDGETS_MS]);
	} finally {
		vi.useRealTimers();
	}
});
