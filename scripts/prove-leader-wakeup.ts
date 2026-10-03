import {
	deleteAgentSessionForOwner,
	insertAgentSession,
} from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import { cancelServerTurn } from "#/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "#/server/services/codex-subscription-session";

if (process.env.LEADER_WAKEUP_PROOF !== "1")
	throw new Error(
		"Enable LEADER_WAKEUP_PROOF=1. This uses subscription inference only, without new VMs or repository tools.",
	);
const db = database();
const created: { userId: string; id: string }[] = [];
async function settled(id: string) {
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		const row = (
			await db.query(
				"select turn_status,items from agent_session where id=$1",
				[id],
			)
		).rows[0];
		if (row?.turn_status !== "running") return row;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error("Proof turn exceeded its deadline.");
}
try {
	const source = (
		await db.query(
			"select user_id,project_id,workspace_id,listed_model_id from agent_session where id=$1",
			["a72e59f3-b0e7-4d08-8271-a97ae8512f32"],
		)
	).rows[0];
	if (!source) throw new Error("Proof source is unavailable.");
	const base = {
		userId: source.user_id,
		projectId: source.project_id,
		workspaceId: source.workspace_id,
		harness: "codex" as const,
		listedModelId: source.listed_model_id,
	};
	const parent = await insertAgentSession({
		...base,
		title: "Isolated leader notification proof",
	});
	created.push({ userId: source.user_id, id: parent.id });
	await sendSubscriptionTask(
		{
			userId: source.user_id,
			projectId: source.project_id,
			sessionId: parent.id,
		},
		{
			modelId: source.listed_model_id,
			text: "This is a control-plane notification test, not a coding request. Do not create children or use any tools. Reply WAITING_NOTIFICATION_PROOF now. If a subsequent internal child-completion notification contains CHILD_NOTIFICATION_PROOF, respond LEADER_OBSERVED_CHILD_PROOF. Do not paste the notification or use tools; there is no repository change to review.",
		},
	);
	if ((await settled(parent.id)).turn_status !== "completed")
		throw new Error("Initial leader turn failed.");
	const child = await insertAgentSession({
		...base,
		parentSessionId: parent.id,
		title: "Notification-only reader",
		task: {
			prompt: "Read-only notification proof",
			placement: "shared",
			access: "read_only",
			execution: "parallel",
			dependsOnSessionId: null,
		},
	});
	created.push({ userId: source.user_id, id: child.id });
	await sendSubscriptionTask(
		{
			userId: source.user_id,
			projectId: source.project_id,
			sessionId: child.id,
		},
		{
			modelId: source.listed_model_id,
			text: "This is a control-plane notification test, not a coding task. Do not use tools, VMs, or create children. Reply exactly CHILD_NOTIFICATION_PROOF and finish.",
		},
	);
	if ((await settled(child.id)).turn_status !== "completed")
		throw new Error("Child proof turn failed.");
	const deadline = Date.now() + 90000;
	let proof = false;
	while (Date.now() < deadline) {
		const event = (
			await db.query(
				"select status,created_at,delivered_at from agent_task_event where child_session_id=$1 and event_type='completed'",
				[child.id],
			)
		).rows[0];
		const leader = (
			await db.query(
				"select turn_status,items from agent_session where id=$1",
				[parent.id],
			)
		).rows[0];
		if (
			event?.status === "delivered" &&
			leader.turn_status === "completed" &&
			leader.items.some(
				(item: { kind: string; text?: string }) =>
					item.kind === "agentMessage" &&
					item.text?.includes("LEADER_OBSERVED_CHILD_PROOF"),
			)
		) {
			console.info(
				JSON.stringify({
					parentAwakened: true,
					childCompletionObserved: true,
					notificationLatencyMs:
						new Date(event.delivered_at).getTime() -
						new Date(event.created_at).getTime(),
					newVms: 0,
					apiFallback: false,
				}),
			);
			proof = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	if (!proof)
		throw new Error(
			"Leader did not observe the child completion before the deadline.",
		);
} finally {
	for (const session of created.reverse()) {
		await cancelServerTurn(session.userId, session.id);
		await settled(session.id);
		await deleteAgentSessionForOwner(session.userId, session.id);
	}
	await closeDatabase();
}
