import { posixShellQuoted } from "#/domain/posix-command";
import { repositoriesForProject } from "#/domain/projects";
import { sessionBranchName } from "#/domain/session-branch";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	agentSessionForOwner,
	saveAgentTaskPublication,
} from "../adapters/agent-sessions";
import { authorizedRepository, compareBranchAhead } from "../adapters/github";
import { ensureAppDraftPullRequest } from "../adapters/github/app-pull-request";
import { pushBrokeredRepository } from "../adapters/github/git-broker";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import { githubAccessToken } from "../auth/github-connection";
import { queuePullRequestEvidence } from "./pr-evidence-job";

export type TurnGitRuntime = Pick<WorkspaceRuntime, "exec"> &
	Partial<Pick<WorkspaceRuntime, "readTextFile" | "writeTextFile">>;

/** Draft handoff happens before completion, without accepting or merging the task. */
export async function publishCompletedSessionTurn(
	session: AgentSessionRecord,
	runtime: TurnGitRuntime,
	turn: string,
) {
	if (!/^[a-f0-9]{64}$/.test(turn))
		throw new Error("Invalid turn handoff identity.");
	const revision = `refs/ytimesy/turn-commits/${turn}`;
	if (
		!session.providerRef ||
		session.taskAccess === "read_only" ||
		session.taskPlacement === "shared"
	)
		return;
	const project = await projectForOwner(session.userId, session.projectId);
	if (!project)
		throw new Error("The chat's project is unavailable for automatic handoff.");
	const predecessor =
		session.taskExecution === "stacked" && session.dependsOnSessionId
			? await agentSessionForOwner(session.userId, session.dependsOnSessionId)
			: null;
	if (
		session.taskExecution === "stacked" &&
		(!predecessor?.taskBranch || predecessor.projectId !== session.projectId)
	)
		throw new Error("The stacked task's published base is unavailable.");
	const head =
		session.workingBranch ||
		session.taskBranch ||
		sessionBranchName({ title: session.title, id: session.id });
	const providerRef = session.providerRef;
	let token: string | undefined;
	for (const repo of repositoriesForProject(project)) {
		const directory = repositoryDirectory(repo.fullName);
		const changed = await runtime.exec(
			providerRef,
			[
				"bash",
				"-lc",
				`git -C ${posixShellQuoted(directory)} rev-list --count refs/ytimesy/base..${revision}`,
			],
			{},
			15_000,
		);
		if (changed.exitCode !== 0)
			throw new Error(`Could not check committed changes in ${repo.fullName}.`);
		if (changed.stdout.trim() === "0") continue;
		token ??= await githubAccessToken(session.userId);
		const repository = await authorizedRepository(
			token,
			repo.installationId,
			repo.repositoryId,
		);
		const primary = repo.fullName === project.fullName;
		const base = primary
			? predecessor?.taskBranch ||
				session.baseBranch ||
				repository.defaultBranch
			: repo.branch || repository.defaultBranch;
		if (head === base || head === repository.defaultBranch)
			throw new Error("Automatic handoff requires a separate task branch.");
		await pushBrokeredRepository(
			{
				exec: (command, timeout) =>
					runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout),
				writeTextFile: (path, contents) => {
					if (!runtime.writeTextFile)
						throw new Error("Workspace file transfer unavailable.");
					return runtime.writeTextFile(providerRef, path, contents);
				},
				readTextFile: (path) => {
					if (!runtime.readTextFile)
						throw new Error("Workspace file transfer unavailable.");
					return runtime.readTextFile(providerRef, path);
				},
			},
			{
				owner: repo.fullName.split("/")[0],
				userId: session.userId,
				projectId: project.id,
				name: repo.fullName.split("/")[1],
				branch: head,
				baseBranch: base,
				installationId: repo.installationId,
				directory,
				revision,
			},
		);
		if ((await compareBranchAhead(token, repo.fullName, base, head)) < 1)
			continue;
		const pull = await ensureAppDraftPullRequest(
			repo.installationId,
			repo.fullName,
			{
				title:
					session.title.replace(/\s+/g, " ").trim().slice(0, 100) ||
					"Agent changes",
				body: "Automatic draft handoff from ytimesy. Review the changes and verification evidence before merging.",
				head,
				base,
			},
		);
		// Harness-captured evidence (prEvidence=on) runs as a background job after
		// the handoff; queueing never blocks or fails the turn.
		if (primary && "number" in pull && typeof pull.number === "number")
			await queuePullRequestEvidence({
				userId: session.userId,
				sessionId: session.id,
				revision,
				installationId: Number(repo.installationId),
				fullName: repo.fullName,
				pullNumber: pull.number,
			}).catch((error) =>
				console.warn("Pull request evidence could not be queued.", {
					message:
						error instanceof Error ? error.message.slice(0, 300) : "unknown",
				}),
			);
		if (primary && session.parentSessionId)
			await saveAgentTaskPublication(session.id, {
				branch: head,
				pullRequestUrl: pull.url,
			});
	}
}
