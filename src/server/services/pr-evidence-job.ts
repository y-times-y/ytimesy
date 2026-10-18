import type { BackgroundJob } from "#/domain/background-job";
import { WorkspaceId } from "#/domain/ids";
import { posixShellCommand } from "#/domain/posix-command";
import { repositoriesForProject } from "#/domain/projects";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import {
	attachPullRequestEvidence,
	type EvidenceOutcome,
	pullRequestEvidenceEnabled,
} from "./pr-evidence";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { TurnGitRuntime } from "./turn-publication";
import type { WorkspaceMachines } from "./workspace-machines";

type EvidenceJob = Extract<BackgroundJob, { kind: "pr-evidence" }>;
type EvidenceJobInput = Omit<EvidenceJob, "id" | "kind">;

/**
 * Called at a turn's draft handoff: queues the capture as a background job
 * and returns at once, so evidence never delays the turn. Only users with
 * prEvidence=on queue anything.
 */
export async function queuePullRequestEvidence(
	input: EvidenceJobInput,
	deps: {
		enabled?: (userId: string) => Promise<boolean>;
		dispatch?: typeof dispatchBackgroundJob;
	} = {},
) {
	const enabled =
		deps.enabled ?? ((userId) => pullRequestEvidenceEnabled(userId));
	if (!(await enabled(input.userId))) return false;
	const job: EvidenceJob = {
		id: backgroundJobId(
			`pr-evidence:${input.sessionId}:${input.revision}:${input.fullName}#${input.pullNumber}`,
		),
		kind: "pr-evidence",
		...input,
	};
	const queued = await (deps.dispatch ?? dispatchBackgroundJob)(job);
	if (!queued)
		console.warn("Pull request evidence was not queued: no background runner.");
	return queued;
}

const TURN_SETTLE_POLLS = 20;
const TURN_SETTLE_MS = 3_000;

/**
 * The job: waits briefly for the turn to be reported complete, re-checks
 * that the repository belongs to the chat's project, wakes the workspace and
 * runs the capture there.
 */
export async function runPullRequestEvidenceJob(
	machines: WorkspaceMachines,
	job: EvidenceJobInput,
	options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<EvidenceOutcome | { kind: "unavailable" }> {
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let session = await agentSessionForOwner(job.userId, job.sessionId);
	for (
		let poll = 0;
		session?.turnStatus === "running" && poll < TURN_SETTLE_POLLS;
		poll++
	) {
		await sleep(TURN_SETTLE_MS);
		session = await agentSessionForOwner(job.userId, job.sessionId);
	}
	if (!session?.providerRef) return { kind: "unavailable" };
	const project = await projectForOwner(job.userId, session.projectId);
	const repository = project
		? repositoriesForProject(project).find(
				(repo) =>
					repo.fullName === job.fullName &&
					String(repo.installationId) === String(job.installationId),
			)
		: undefined;
	if (!repository) return { kind: "unavailable" };
	const selected = machinesForAgentSession(machines, session);
	const providerRef = session.providerRef;
	await selected.ensureRunning(WorkspaceId(providerRef));
	const runtime: TurnGitRuntime = {
		exec: (ref, argv, _env, timeout) =>
			selected.exec(WorkspaceId(ref), posixShellCommand(argv), timeout),
		writeTextFile: (ref, path, contents) =>
			selected.writeTextFile(WorkspaceId(ref), path, contents),
		readTextFile: (ref, path) => selected.readTextFile(WorkspaceId(ref), path),
	};
	return attachPullRequestEvidence({
		userId: job.userId,
		runtime,
		providerRef,
		directory: repositoryDirectory(repository.fullName),
		revision: job.revision,
		installationId: job.installationId,
		fullName: job.fullName,
		pullNumber: job.pullNumber,
	});
}
