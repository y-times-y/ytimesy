import { createHash, randomUUID } from "node:crypto";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import { repositoriesForProject } from "#/domain/projects";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	exportGuestCheckpoint,
	restoreGuestCheckpoint,
} from "../adapters/checkpoints/guest";
import {
	checkpointForSession,
	confirmUnchangedCheckpoint,
	saveSessionCheckpoint,
} from "../adapters/checkpoints/records";
import {
	downloadCheckpoint,
	removeCheckpoint,
	uploadCheckpoint,
} from "../adapters/checkpoints/storage";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { codexRuntimeForSession } from "./codex-runtime";
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

/** Queue-owned capture only after a turn settles. Never wake machines on ordinary UI reads. */
export async function captureSessionCheckpoint(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
) {
	const session = await agentSessionForOwner(userId, sessionId);
	if (!session?.providerRef || session.turnStatus === "running") return;
	const fingerprint = createHash("sha256")
		.update("checkpoint-v2:")
		.update(JSON.stringify(session.items))
		.digest("hex");
	const previous = await checkpointForSession(userId, sessionId);
	if (previous?.turn_fingerprint === fingerprint) {
		await confirmUnchangedCheckpoint(userId, sessionId, fingerprint);
		return;
	}
	const selected = machinesForAgentSession(machines, session);
	await selected.ensureRunning(WorkspaceId(session.providerRef));
	const project = await projectForOwner(userId, session.projectId);
	if (!project) return;
	const paths =
		session.taskPlacement === "shared"
			? []
			: repositoriesForProject(project).map((repo) =>
					repositoryDirectory(repo.fullName),
				);
	const transfer = `/tmp/ytimesy-checkpoint-${randomUUID()}`;
	const workspace = await exportGuestCheckpoint(
		host(selected, session.providerRef),
		paths,
		null,
		transfer,
	);
	const runtime =
		session.harness === "codex"
			? await codexRuntimeForSession(selected, {
					...session,
					providerRef: session.providerRef,
				})
			: null;
	if (runtime)
		await runtime.machines.ensureRunning(WorkspaceId(runtime.workspaceId));
	const native = runtime
		? await exportGuestCheckpoint(
				host(runtime.machines, runtime.workspaceId),
				[],
				runtime.root,
				transfer,
			)
		: null;
	const latest = await agentSessionForOwner(userId, sessionId);
	if (
		!latest ||
		latest.turnStatus === "running" ||
		createHash("sha256")
			.update("checkpoint-v2:")
			.update(JSON.stringify(latest.items))
			.digest("hex") !== fingerprint
	)
		throw new Error(
			"Conversation advanced while capturing its checkpoint; retrying.",
		);
	const path = await uploadCheckpoint(
		userId,
		sessionId,
		randomUUID(),
		JSON.stringify({ workspace, native }),
	);
	try {
		await saveSessionCheckpoint({
			userId,
			sessionId,
			path,
			fingerprint,
			executorId: session.providerRef,
			runnerId: runtime?.workspaceId ?? null,
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
	if (!checkpoint || !session || session.taskPlacement === "shared")
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

export async function restoreSessionNativeState(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	runnerId: string,
	root: string,
) {
	const checkpoint = await checkpointForSession(userId, sessionId);
	if (!checkpoint)
		throw new Error(
			"No recoverable Codex checkpoint exists for this conversation.",
		);
	const payload = JSON.parse(
		await downloadCheckpoint(userId, sessionId, checkpoint.object_path),
	);
	if (!payload.native)
		throw new Error("This checkpoint has no saved Codex history.");
	await restoreGuestCheckpoint(
		host(machines, runnerId),
		payload.native,
		[],
		root,
		`/tmp/ytimesy-restore-${randomUUID()}`,
	);
}
