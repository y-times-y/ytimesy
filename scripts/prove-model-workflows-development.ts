import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import {
	type SessionItem,
	sessionItemsQueuedWithUser,
} from "#/domain/session-item";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import { enqueueApiTurn } from "#/server/adapters/api-turns";
import { codexSubscriptionCatalog } from "#/server/adapters/codex-subscription";
import { closeDatabase, database } from "#/server/adapters/database";
import { modelWorkflowSigningSecret } from "#/server/adapters/model-workflow-dispatch";
import { listProjects } from "#/server/adapters/projects";
import { openAgentSession } from "#/server/services/agent-session-machine";

if (!process.argv.includes("--run"))
	throw new Error(
		"Explicit --run is required; this uses the existing Codex subscription.",
	);
const development = "exampledevprojectref";
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
		development ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(development)
)
	throw new Error("Not the approved development database.");
const userId = process.env.YTIMESY_ADMIN_USER_IDS?.split(",")[0]?.trim();
if (!userId)
	throw new Error("Select the existing authorized development owner.");
let sessionId: string | undefined;
let turnId: string | undefined;
try {
	const projects = await listProjects(userId);
	const project = projects.find((row) => row.fullName === "y-times-y/ytimesy");
	if (!project)
		throw new Error("The owner's existing ytimesy project is unavailable.");
	const catalog = await codexSubscriptionCatalog(userId);
	const model = catalog.find((row) => row.id.includes("luna")) ?? catalog[0];
	if (!model) throw new Error("No subscription model is available.");
	const session = await openAgentSession({
		userId,
		projectId: project.id,
		harness: "codex",
		title: "Durable workflow verification",
	});
	sessionId = session.id;
	turnId = randomUUID();
	const leaseId = randomUUID();
	const prompt =
		"This is a read-only infrastructure verification, not a coding task. Call list_peers exactly once, then reply with the exact text workflow-proof-complete. Do not call repository, terminal, browser, delegation or publication tools. No workspace VM is needed.";
	if (process.argv.includes("--queued")) {
		await enqueueApiTurn({
			userId,
			sessionId,
			connectionId: null,
			revision: subscriptionTurnRevision(),
			modelId: model.id,
			routeId: model.id,
			messages: [{ role: "user", content: prompt }],
			items: sessionItemsQueuedWithUser([], prompt),
		});
		turnId = (
			await database().query<{ id: string }>(
				"select id from api_turn where session_id=$1 order by created_at desc limit 1",
				[sessionId],
			)
		).rows[0].id;
		console.info(
			`Queued development workflow turn: ${turnId}; model ${model.id}.`,
		);
	} else {
		const client = await database().connect();
		try {
			await client.query("begin");
			await client.query("select pg_advisory_xact_lock(81738419)");
			if (
				(
					await client.query(
						"select 1 from api_turn where state='running' limit 1",
					)
				).rowCount
			)
				throw new Error(
					"Wait until existing model turns finish before the isolated proof.",
				);
			await client.query(
				`insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,messages,items,lease_id,heartbeat_at)
		 values($1,$2,$3,null,$4,$5,'running',$6,$7,$8,now())`,
				[
					turnId,
					sessionId,
					userId,
					subscriptionTurnRevision(),
					model.id,
					JSON.stringify([{ role: "user", content: prompt }]),
					JSON.stringify(sessionItemsQueuedWithUser([], prompt)),
					leaseId,
				],
			);
			await client.query(
				"update agent_session set turn_status='running',listed_model_id=$2 where id=$1 and user_id=$3",
				[sessionId, model.id, userId],
			);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}
		const url =
			"https://ytimesy-model-workflows-development.example-account.workers.dev/start";
		const body = JSON.stringify({ turnId, leaseId });
		const admitted = await fetch(url, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(
				modelWorkflowSigningSecret(),
				"POST",
				url,
				body,
			),
			signal: AbortSignal.timeout(10_000),
		});
		if (admitted.status !== 202)
			throw new Error(`Workflow was not admitted (${admitted.status}).`);
		console.info(
			`Live development workflow started: ${turnId}-${leaseId}; model ${model.id}.`,
		);
	}
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const saved = (
			await database().query<{ state: string; items: SessionItem[] }>(
				"select state,items from api_turn where id=$1",
				[turnId],
			)
		).rows[0];
		if (saved.state !== "running" && saved.state !== "queued") {
			if (saved.state !== "completed") {
				const error = [...saved.items]
					.reverse()
					.find((item) => item.kind === "error");
				throw new Error(
					error?.kind === "error"
						? error.message
						: `Turn ended ${saved.state}.`,
				);
			}
			const receipts = (
				await database().query(
					"select step_index,state,outcome from model_workflow_step where turn_id=$1 order by step_index",
					[turnId],
				)
			).rows;
			const tools = saved.items.filter(
				(item) =>
					item.kind === "dynamicToolCall" &&
					item.tool === "list_peers" &&
					item.status === "completed",
			);
			const message = [...saved.items]
				.reverse()
				.find((item) => item.kind === "userMessage");
			const usage =
				message?.kind === "userMessage" ? message.apiUsage : undefined;
			const context =
				message?.kind === "userMessage"
					? message.contextUsage?.context
					: undefined;
			const response = saved.items
				.filter((item) => item.kind === "agentMessage")
				.map((item) => item.text)
				.join("\n");
			const binding = (
				await database().query(
					"select provider_ref from agent_session where id=$1",
					[sessionId],
				)
			).rows[0];
			if (
				receipts.length < 2 ||
				tools.length !== 1 ||
				!response.includes("workflow-proof-complete") ||
				usage?.inputTokens == null ||
				!context ||
				binding.provider_ref
			)
				throw new Error(
					"Live proof did not meet the required tool, progress, usage, context and no-VM assertions.",
				);
			console.info(
				JSON.stringify(
					{
						sessionId,
						turnId,
						receipts,
						usage,
						context,
						executionVmCreated: false,
					},
					null,
					2,
				),
			);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	if (
		(await database().query("select state from api_turn where id=$1", [turnId]))
			.rows[0]?.state !== "completed"
	)
		throw new Error("Live workflow proof deadline reached.");
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "Live workflow proof failed.",
	);
	process.exitCode = 1;
} finally {
	if (sessionId)
		console.info(
			`Verification chat retained for inspection: ${sessionId}. No existing chat was modified.`,
		);
	await closeDatabase();
}
