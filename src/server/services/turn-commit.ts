import { createHash } from "node:crypto";
import { repositoriesForProject } from "#/domain/projects";
import { lastUserMessageText, type SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { automaticTurnCommitArgv } from "../adapters/turn-commit";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";

/** Runs before completed status and task review events become visible. Never publishes to the remote. */
export async function commitCompletedSessionTurn(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
	runtime?: Pick<WorkspaceRuntime, "exec">,
) {
	if (
		!session.providerRef ||
		session.taskPlacement === "shared" ||
		session.taskAccess === "read_only"
	)
		return;
	const project = await projectForOwner(session.userId, session.projectId);
	if (!project)
		throw new Error("The chat's project is unavailable for automatic commit.");
	const users = items.filter((item) => item.kind === "userMessage");
	const user = users.at(-1);
	const turn = createHash("sha256")
		.update(
			JSON.stringify([
				session.id,
				users.length,
				user?.kind === "userMessage" ? user.text : null,
				user?.kind === "userMessage" ? user.timing?.startedAt : null,
			]),
		)
		.digest("hex");
	const description = (lastUserMessageText(items) || session.title)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 72);
	const host = runtime ?? workspaceRuntimeFromEnv();
	for (const repo of repositoriesForProject(project)) {
		const result = await host.exec(
			session.providerRef,
			automaticTurnCommitArgv(
				repositoryDirectory(repo.fullName),
				turn,
				`Agent: ${description || "Update workspace"}`,
			),
			{},
			60_000,
		);
		if (result.exitCode !== 0)
			throw new Error(
				`Automatic commit failed for ${repo.fullName}: ${(result.stderr || result.stdout).trim().slice(0, 500) || "Check Git status in Terminal and retry."}`,
			);
	}
}
