import { createHash } from "node:crypto";
import { posix } from "node:path";
import { projectFolderName, repositoriesForProject } from "#/domain/projects";
import { lastUserMessageText, type SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { evaluationRunForTask } from "../adapters/harness-evaluation";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { automaticTurnCommitArgv } from "../adapters/turn-commit";
import { verifyCompletedRepository } from "./completion-verification";
import {
	publishCompletedSessionTurn,
	type TurnGitRuntime,
} from "./turn-publication";

/** Commits and hands off a draft before completed status and task review events become visible. */
export async function commitCompletedSessionTurn(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
	runtime?: TurnGitRuntime,
	signal?: AbortSignal,
) {
	if (
		!session.providerRef ||
		session.taskPlacement === "shared" ||
		session.taskAccess === "read_only"
	)
		return;
	const evaluation =
		process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1" &&
		(await evaluationRunForTask(session.userId, session.id));
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
	// Baselines are pinned under the checkout's recorded path ($HOME/<repo>),
	// not a fixed home directory, so completion must look them up the same way.
	const recorded = (
		await host.readTextFile?.(session.providerRef, PROJECT_CWD_PATH)
	)?.trim();
	const projectDirectory = recorded?.startsWith("/") ? recorded : null;
	for (const repo of repositoriesForProject(project)) {
		const directory = !projectDirectory
			? repositoryDirectory(repo.fullName)
			: repo.fullName === project.fullName
				? projectDirectory
				: posix.join(
						posix.dirname(projectDirectory),
						projectFolderName(repo.fullName),
					);
		const verification = await verifyCompletedRepository({
			runtime: host,
			providerRef: session.providerRef,
			directory,
			userId: session.userId,
			sessionId: session.id,
			turn,
			signal,
		});
		if (evaluation) continue;
		const result = await host.exec(
			session.providerRef,
			automaticTurnCommitArgv(
				directory,
				turn,
				`Agent: ${description || "Update workspace"}`,
				verification.tree,
			),
			{},
			60_000,
		);
		if (result.exitCode !== 0)
			throw new Error(
				`Automatic commit failed for ${repo.fullName}: ${(result.stderr || result.stdout).trim().slice(0, 500) || "Check Git status in Terminal and retry."}`,
			);
	}
	if (evaluation) return;
	await publishCompletedSessionTurn(session, host, turn);
}
