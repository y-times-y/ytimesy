import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { closeJobQueueForTests } from "#/server/jobs/queue";
import {
	bindAgentSessionMachine,
	deleteAgentSessionMachine,
	openAgentSession,
	openAgentTask,
} from "#/server/services/agent-session-machine";
import { codexRuntimeForSession } from "#/server/services/codex-runtime";
import {
	readHarnessWorkspaceSession,
	startPreparedAgentTask,
	stopHarnessWorkspaceTurn,
} from "#/server/services/harness-workspace-session";
import { machinesForAgentSession } from "#/server/services/session-workspace-machines";

const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Freestyle credentials are required.");
const selection = await database().query<{
	user_id: string;
	project_id: string;
	listed_model_id: string;
}>(
	"select user_id,project_id,listed_model_id from agent_session where harness='codex' and listed_model_id is not null and turn_status<>'running' order by updated_at desc limit 1",
);
const selected = selection.rows[0];
if (!selected) throw new Error("No connected Codex project is available.");
const machines = createFreestyleWorkspaceMachines(key);
const scope = {
	userId: selected.user_id,
	projectId: selected.project_id,
	harnessId: "codex" as const,
};
const nonce = `PEER_PROOF_${randomUUID().slice(0, 8)}`;
let rootId: string | undefined;
const childIds: string[] = [];
try {
	const root = await openAgentSession({
		...scope,
		harness: "codex",
		title: "Peer coordination verification",
	});
	rootId = root.id;
	await bindAgentSessionMachine(machines, {
		...scope,
		harness: "codex",
		sessionId: root.id,
	});
	const receiver = await openAgentTask({
		...scope,
		parentSessionId: root.id,
		title: "Receive peer finding",
		harness: "codex",
		modelId: selected.listed_model_id,
		prompt:
			"Read-only coordination verification. Do not edit, delegate, or publish. Run a shell command sleeping 90 seconds, then respond READY. If a later peer message includes a PEER_PROOF_ marker, report that exact marker and confirm receipt. Do not send acknowledgements to other agents.",
		placement: "shared",
		access: "read_only",
		execution: "parallel",
		dependsOnSessionId: null,
	});
	childIds.push(receiver.id);
	const sender = await openAgentTask({
		...scope,
		parentSessionId: root.id,
		title: "Share peer finding",
		harness: "codex",
		modelId: selected.listed_model_id,
		prompt: `Read-only coordination verification. Do not edit, delegate, or publish. Use list_peers to discover and confirm peer task ${receiver.id}. Use send_peer_message to send this exact finding to that task: "${nonce}: I am handing the duplicate investigation to you; please own src/schema.ts investigation. No edits are authorized." Then respond SENT.`,
		placement: "shared",
		access: "read_only",
		execution: "parallel",
		dependsOnSessionId: null,
	});
	childIds.push(sender.id);
	await Effect.runPromise(startPreparedAgentTask(machines, scope, receiver.id));
	const runningReceiver = await agentSessionForOwner(scope.userId, receiver.id);
	if (!runningReceiver?.providerRef)
		throw new Error("Receiver runtime is unavailable.");
	const runtime = await codexRuntimeForSession(
		machinesForAgentSession(machines, runningReceiver),
		{ ...runningReceiver, providerRef: runningReceiver.providerRef },
	);
	const readState = async () =>
		JSON.parse(
			(await runtime.machines.readTextFile(
				runtime.workspaceId,
				"/tmp/ytimesy-codex-thread-state.json",
			)) ?? "{}",
		);
	let originalTaskId: string | null = null;
	for (let attempt = 0; attempt < 20 && !originalTaskId; attempt++) {
		originalTaskId = (await readState()).activeTaskId ?? null;
		if (!originalTaskId)
			await new Promise((resolve) => setTimeout(resolve, 500));
	}
	if (!originalTaskId)
		throw new Error("Receiver did not begin its original task.");
	await Effect.runPromise(startPreparedAgentTask(machines, scope, sender.id));
	let receivedDuringOriginalTask = false;
	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		for (const sessionId of childIds)
			await Effect.runPromise(
				readHarnessWorkspaceSession(machines, { ...scope, sessionId }),
			);
		const recipient = await agentSessionForOwner(scope.userId, receiver.id);
		const items = sessionItemsFromUnknown(recipient?.items);
		const state = await readState();
		if (
			state.activeTaskId === originalTaskId &&
			JSON.stringify(state.items).includes(nonce)
		)
			receivedDuringOriginalTask = true;
		if (
			recipient?.turnStatus !== "running" &&
			items.some(
				(item) => item.kind === "agentMessage" && item.text.includes(nonce),
			)
		) {
			console.info(
				JSON.stringify({
					passed: true,
					model: selected.listed_model_id,
					discoveredSibling: true,
					livePeerFindingReceived: true,
					messageInjectedDuringOriginalTask: receivedDuringOriginalTask,
				}),
			);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	const recipient = await agentSessionForOwner(scope.userId, receiver.id);
	if (
		!sessionItemsFromUnknown(recipient?.items).some(
			(item) => item.kind === "agentMessage" && item.text.includes(nonce),
		)
	)
		throw new Error(
			"Live coordination did not complete within the bounded test window.",
		);
	if (!receivedDuringOriginalTask)
		throw new Error(
			"Receipt passed, but injection during the original active task was not observed.",
		);
} finally {
	for (const sessionId of [...childIds, ...(rootId ? [rootId] : [])])
		await Effect.runPromise(
			stopHarnessWorkspaceTurn(machines, { ...scope, sessionId }),
		).catch(() => undefined);
	if (rootId) {
		await deleteAgentSessionMachine(machines, { ...scope, sessionId: rootId });
		console.info(
			"Disposable verification chats and execution VM removed; shared user runner retained.",
		);
	}
	await closeJobQueueForTests();
	await closeDatabase();
}
