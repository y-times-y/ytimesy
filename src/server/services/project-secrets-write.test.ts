import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	AGENT_SECRETS_ENV_PATH,
	PROJECT_SECRETS_PREPARATION_FAILED,
} from "#/domain/project-secret";
import { writeAgentProjectSecrets } from "./project-secrets";
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
