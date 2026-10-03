import {
	deleteAgentSessionForOwner,
	insertAgentSession,
} from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import { cancelServerTurn } from "#/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "#/server/services/codex-subscription-session";

if (process.env.HARNESS_TOOL_PROOF !== "1")
	throw new Error(
		"Enable HARNESS_TOOL_PROOF=1 for this subscription-only test. No VM or paid API inference is used.",
	);
const db = database();
let created: { userId: string; id: string } | undefined;
try {
	const source = (
		await db.query(
			"select user_id,project_id,workspace_id,listed_model_id from agent_session where id=$1",
			["a72e59f3-b0e7-4d08-8271-a97ae8512f32"],
		)
	).rows[0];
	if (!source) throw new Error("Proof source is unavailable.");
	const session = await insertAgentSession({
		userId: source.user_id,
		projectId: source.project_id,
		workspaceId: source.workspace_id,
		harness: "codex",
		title: "Isolated tool evidence proof",
		listedModelId: source.listed_model_id,
	});
	created = { userId: source.user_id, id: session.id };
	await sendSubscriptionTask(
		{
			userId: source.user_id,
			projectId: source.project_id,
			sessionId: session.id,
		},
		{
			modelId: source.listed_model_id,
			variant: "high",
			text: "This is a read-only control-plane test, not a coding task. Do not use repository tools or create children. Call list_tasks exactly once to inspect this new empty task list. Then report its count and finish with TOOL_EVIDENCE_PROOF_COMPLETE.",
		},
	);
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		const current = (
			await db.query(
				"select turn_status,items from agent_session where id=$1",
				[session.id],
			)
		).rows[0];
		if (current.turn_status !== "running") {
			const tools = current.items.filter(
				(item: { kind: string }) => item.kind === "dynamicToolCall",
			);
			const final = current.items.some(
				(item: { kind: string; text?: string }) =>
					item.kind === "agentMessage" &&
					item.text?.includes("TOOL_EVIDENCE_PROOF_COMPLETE"),
			);
			if (
				current.turn_status !== "completed" ||
				!final ||
				!tools.some(
					(item: { tool: string; input?: string; output?: string }) =>
						item.tool === "list_tasks" && item.input && item.output,
				)
			)
				throw new Error("Live tool evidence did not complete.");
			console.info(
				JSON.stringify({
					completed: true,
					toolCalls: tools.length,
					inputsAndResultsRecorded: true,
					reasoningRecorded: current.items.some(
						(item: { kind: string }) => item.kind === "reasoning",
					),
					newVms: 0,
				}),
			);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	if (Date.now() >= deadline)
		throw new Error("Live proof exceeded its bounded deadline.");
} finally {
	if (created) {
		await cancelServerTurn(created.userId, created.id);
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const current = (
				await db.query("select turn_status from agent_session where id=$1", [
					created.id,
				])
			).rows[0];
			if (current.turn_status !== "running") {
				await deleteAgentSessionForOwner(created.userId, created.id);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}
	await closeDatabase();
}
