import { z } from "zod";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { environmentRecipe } from "#/domain/project-environment";
import type { WorkspaceMachines } from "./workspace-machines";

export const preparedEnvironment = z.object({
	version: z.literal(1),
	repositories: z
		.array(
			z.object({
				repositoryId: z.number(),
				fullName: z.string(),
				directory: z.string().startsWith("/"),
				recipe: environmentRecipe,
				commit: z.string(),
			}),
		)
		.min(1)
		.max(10),
});

/** Services live in named tmux terminals and are reused when their port is ready. */
export async function startEnvironmentServices(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
) {
	const contents = await machines.readTextFile(
		vm,
		"/tmp/ytimesy-environment.json",
	);
	if (!contents) return;
	const environment = preparedEnvironment.parse(JSON.parse(contents));
	for (const repo of environment.repositories) {
		for (const service of repo.recipe.services) {
			const session = `ytimesy-${repo.repositoryId}-${service.name}`;
			const command = `set -e; cd ${quote(repo.directory)}; if [ -f "$HOME/.ytimesy-agent-secrets.env" ]; then . "$HOME/.ytimesy-agent-secrets.env"; fi; ${service.command}`;
			const script = `set -eu
ready() { (echo > /dev/tcp/127.0.0.1/${service.port}) >/dev/null 2>&1; }
if ready; then exit 0; fi
command -v tmux >/dev/null || { echo 'tmux is required by environment services' >&2; exit 1; }
if ! tmux has-session -t ${quote(session)} 2>/dev/null; then
  tmux new-session -d -s ${quote(session)} bash -lc ${quote(command)}
fi
for ((i=0;i<${service.timeoutSeconds};i++)); do
  if ready; then exit 0; fi
  tmux has-session -t ${quote(session)} 2>/dev/null || exit 1
  sleep 1
done
exit 1`;
			const result = await machines.exec(
				vm,
				`bash -c ${quote(script)}`,
				(service.timeoutSeconds + 5) * 1000,
			);
			if (result.exitCode !== 0)
				throw new Error(
					`${repo.fullName}: ${service.name} did not become ready on port ${service.port}. Inspect its terminal output.`,
				);
		}
	}
}
