import { createHash, randomUUID } from "node:crypto";
import { failureCause } from "#/domain/api-turn-failure";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import { repositoriesForProject } from "#/domain/projects";
import { sharesParentMachine } from "#/domain/subagent";
import {
	agentSessionForOwner,
	agentSessionItemsFingerprint,
	agentSessionMetadataForOwner,
} from "../adapters/agent-sessions";
import {
	exportGuestCheckpoint,
	restoreGuestCheckpoint,
} from "../adapters/checkpoints/guest";
import {
	type CheckpointStage,
	checkpointForSession,
	clearCheckpointFailure,
	confirmUnchangedCheckpoint,
	recordCheckpointFailure,
	saveSessionCheckpoint,
} from "../adapters/checkpoints/records";
import {
	downloadCheckpoint,
	removeCheckpoint,
	uploadCheckpoint,
} from "../adapters/checkpoints/storage";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

function host(machines: WorkspaceMachines, id: string) {
	const workspaceId = WorkspaceId(id);
	return {
		exec: (command: string, timeout: number) =>
			machines.exec(workspaceId, command, timeout),
		writeTextFile: (path: string, text: string) =>
			machines.writeTextFile(workspaceId, path, text),
		readTextFile: (path: string) => machines.readTextFile(workspaceId, path),
	};
}

/**
 * Queue-owned capture only after a turn settles. Never wake machines on ordinary UI reads.
 * A failure is recorded with its stage and backs off the per-minute backstop.
 */
export async function captureSessionCheckpoint(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
) {
	const progress: { stage: CheckpointStage } = { stage: "wake" };
	try {
		await captureSessionCheckpointStages(machines, userId, sessionId, progress);
	} catch (error) {
		// Only the stage is stored; the redacted cause goes to the logs.
		console.warn("Session checkpoint failed", {
			stage: progress.stage,
			sessionId,
			cause: failureCause(error),
		});
		await recordCheckpointFailure(sessionId, progress.stage).catch(
			() => undefined,
		);
		throw error;
	}
	await clearCheckpointFailure(sessionId);
}

async function captureSessionCheckpointStages(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	progress: { stage: CheckpointStage },
) {
	const session = await agentSessionMetadataForOwner(userId, sessionId);
	if (!session?.providerRef || session.turnStatus === "running") return;
	const fingerprint = await agentSessionItemsFingerprint(userId, sessionId);
	const previous = await checkpointForSession(userId, sessionId);
	const project = await projectForOwner(userId, session.projectId);
	if (!project) return;
	const selected = machinesForAgentSession(machines, session);
	await selected.ensureRunning(WorkspaceId(session.providerRef));
	const paths = sharesParentMachine(session)
		? []
		: repositoriesForProject(project).map((repo) =>
				repositoryDirectory(repo.fullName),
			);
	const transfer = `/tmp/ytimesy-checkpoint-${randomUUID()}`;
	progress.stage = "export";
	let workspace: string | null = await exportGuestCheckpoint(
		host(selected, session.providerRef),
		paths,
		null,
		transfer,
	);
	const workspaceSha256 = createHash("sha256").update(workspace).digest("hex");
	// Only legacy checkpoints carry runner state worth retaining, so only they
	// are downloaded; the workspace comparison uses the stored hash.
	const native = previous?.runner_id
		? ((
				JSON.parse(
					await downloadCheckpoint(userId, sessionId, previous.object_path),
				) as { native?: unknown }
			).native ?? null)
		: null;
	const latest = await agentSessionMetadataForOwner(userId, sessionId);
	if (
		!latest ||
		latest.turnStatus === "running" ||
		latest.providerRef !== session.providerRef ||
		(await agentSessionItemsFingerprint(userId, sessionId)) !== fingerprint
	) {
		progress.stage = "advanced";
		throw new Error(
			"Conversation advanced while capturing its checkpoint; retrying.",
		);
	}
	// Transcript equality says nothing about terminal edits. Deduplicate only a fresh file capture.
	if (
		previous?.executor_id === session.providerRef &&
		previous.turn_fingerprint === fingerprint &&
		previous.workspace_sha256 === workspaceSha256
	) {
		await confirmUnchangedCheckpoint(userId, sessionId, fingerprint);
		return;
	}
	progress.stage = "upload";
	const payload = JSON.stringify({ workspace, native });
	// The guest's payload can be 20 MB; only its wrapped copy is needed from here.
	workspace = null;
	const path = await uploadCheckpoint(userId, sessionId, randomUUID(), payload);
	progress.stage = "save";
	try {
		await saveSessionCheckpoint({
			userId,
			sessionId,
			path,
			fingerprint,
			executorId: session.providerRef,
			runnerId: previous?.runner_id ?? null,
			workspaceSha256,
		});
	} catch (error) {
		await removeCheckpoint(path).catch(() => undefined);
		throw error;
	}
	if (previous) await removeCheckpoint(previous.object_path);
}

export async function restoreSessionWorkspace(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	newId: string,
) {
	const checkpoint = await checkpointForSession(userId, sessionId);
	const session = await agentSessionForOwner(userId, sessionId);
	if (!checkpoint || !session || sharesParentMachine(session))
		throw new Error(
			"No recoverable workspace checkpoint exists for this conversation.",
		);
	const project = await projectForOwner(userId, session.projectId);
	if (!project) throw new Error("Project unavailable.");
	const payload = JSON.parse(
		await downloadCheckpoint(userId, sessionId, checkpoint.object_path),
	);
	await restoreGuestCheckpoint(
		host(machines, newId),
		payload.workspace,
		repositoriesForProject(project).map((repo) =>
			repositoryDirectory(repo.fullName),
		),
		null,
		`/tmp/ytimesy-restore-${randomUUID()}`,
	);
	for (const repo of repositoriesForProject(project)) {
		const result = await machines.exec(
			WorkspaceId(newId),
			`git -C ${posixShellQuoted(repositoryDirectory(repo.fullName))} remote add origin ${posixShellQuoted(`https://github.com/${repo.fullName}.git`)}`,
			15_000,
		);
		if (result.exitCode !== 0)
			throw new Error("Could not restore the repository remote.");
	}
}
