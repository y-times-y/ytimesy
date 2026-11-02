import { z } from "zod";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	type EnvironmentRecipe,
	environmentRecipe,
} from "#/domain/project-environment";
import { SOURCE_AGENT_SECRETS } from "#/domain/project-secret";
import type { WorkspaceMachines } from "./workspace-machines";

const ENVIRONMENT_REPORT_PATH = "/tmp/ytimesy-environment.json";

const preparedEnvironment = z
	.object({
		version: z.literal(1),
		repositories: z
			.array(
				z
					.object({
						repositoryId: z.number(),
						fullName: z.string(),
						directory: z.string().startsWith("/"),
						recipe: environmentRecipe,
						commit: z.string(),
					})
					.passthrough(),
			)
			.min(1)
			.max(10),
	})
	.passthrough();

type ServiceRepository = {
	readonly repositoryId: number;
	readonly fullName: string;
	readonly directory: string;
	readonly recipe: Pick<EnvironmentRecipe, "services">;
};

export type EnvironmentServiceResult = {
	readonly repositoryId: number;
	readonly name: string;
	readonly port: number;
	readonly ready: boolean;
	/** The service terminal's last lines when it did not come up. */
	readonly output: string;
};

type ServiceExec = (
	command: string,
	timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string }>;

const sessionName = (repositoryId: number, name: string) =>
	`ytimesy-${repositoryId}-${name}`;

/**
 * Starts each saved service in a named tmux terminal and waits for its port;
 * one already listening is left as it is. A service that does not come up is
 * reported with its terminal's last lines, never thrown.
 */
export async function startRecipeServices(
	exec: ServiceExec,
	repositories: readonly ServiceRepository[],
): Promise<EnvironmentServiceResult[]> {
	const results: EnvironmentServiceResult[] = [];
	for (const repo of repositories) {
		for (const service of repo.recipe.services) {
			const session = sessionName(repo.repositoryId, service.name);
			// The terminal stays open after the command exits, so its output can be read.
			const command = `cd ${quote(repo.directory)}; ${SOURCE_AGENT_SECRETS}; ${service.command}; echo "[exited $?]"; sleep 600`;
			const script = `set -u
ready() { (echo > /dev/tcp/127.0.0.1/${service.port}) >/dev/null 2>&1; }
if ready; then exit 0; fi
command -v tmux >/dev/null || { echo 'tmux is required by environment services'; exit 1; }
if ! tmux has-session -t ${quote(session)} 2>/dev/null; then
  tmux new-session -d -s ${quote(session)} bash -lc ${quote(command)}
fi
for ((i=0;i<${service.timeoutSeconds};i++)); do
  if ready; then exit 0; fi
  sleep 1
done
tmux capture-pane -p -t ${quote(session)} 2>/dev/null | tail -n 20
exit 1`;
			const result = await exec(
				`bash -c ${quote(script)}`,
				(service.timeoutSeconds + 5) * 1000,
			).catch(() => ({ exitCode: 1, stdout: "" }));
			results.push({
				repositoryId: repo.repositoryId,
				name: service.name,
				port: service.port,
				ready: result.exitCode === 0,
				output: result.exitCode === 0 ? "" : result.stdout.slice(-4000),
			});
		}
	}
	return results;
}

/** Stops the services startRecipeServices started (the build checks them once). */
export async function stopRecipeServices(
	exec: ServiceExec,
	repositories: readonly ServiceRepository[],
) {
	const sessions = repositories.flatMap((repo) =>
		repo.recipe.services.map((service) =>
			sessionName(repo.repositoryId, service.name),
		),
	);
	if (!sessions.length) return;
	await exec(
		[
			...sessions.map(
				(session) => `tmux kill-session -t ${quote(session)} 2>/dev/null`,
			),
			"true",
		].join("; "),
		15_000,
	);
}

/**
 * Starts the project's saved services on a chat's machine and adds how each
 * went to the environment report, where the agent reads it.
 */
export async function startEnvironmentServices(
	machines: Pick<WorkspaceMachines, "exec" | "readTextFile" | "writeTextFile">,
	vm: WorkspaceId,
): Promise<EnvironmentServiceResult[]> {
	const contents = await machines.readTextFile(vm, ENVIRONMENT_REPORT_PATH);
	if (!contents) return [];
	const report = preparedEnvironment.parse(JSON.parse(contents));
	if (!report.repositories.some((repo) => repo.recipe.services.length))
		return [];
	const results = await startRecipeServices(
		(command, timeoutMs) => machines.exec(vm, command, timeoutMs),
		report.repositories,
	);
	await machines.writeTextFile(
		vm,
		ENVIRONMENT_REPORT_PATH,
		JSON.stringify({
			...report,
			repositories: report.repositories.map((repo) => ({
				...repo,
				services: results.filter(
					(result) => result.repositoryId === repo.repositoryId,
				),
			})),
		}),
	);
	return results;
}
