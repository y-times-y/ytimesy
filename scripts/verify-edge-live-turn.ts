import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createParser } from "eventsource-parser";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { WorkspaceId } from "../src/domain/ids";
import { modelRouteId } from "../src/domain/model-connection";
import { sessionItemsFromUnknown } from "../src/domain/session-item";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../src/server/adapters/api-turns";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { coordinateConversationTurn } from "../src/server/adapters/conversation-turn-control";
import { closeDatabase, database } from "../src/server/adapters/database";
import { CHEAP_BASE_SNAPSHOT } from "../src/server/adapters/freestyle/product-vm";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import {
	dispatchModelWorkflow,
	modelWorkflowSigningSecret,
} from "../src/server/adapters/model-workflow-dispatch";
import {
	apiModelCatalog,
	sendApiWorkspaceTask,
} from "../src/server/services/api-workspace-session";
import { cancelServerTurn } from "../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../src/server/services/codex-subscription-session";
import { verifiedEdgeProofProgress } from "./edge-proof-progress";

// Operator-only proof: one existing subscription, one TTL-bounded VM, no publication.
if (process.env.EDGE_LIVE_PROOF !== "1")
	throw new Error("Enable EDGE_LIVE_PROOF=1.");
const ref = "exampledevprojectref";
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== ref ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(ref)
)
	throw new Error("Not the approved development database.");
const origin =
	"https://ytimesy-edge-executor-development.example-account.workers.dev";
process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
// This approved operator proof uses its own provider-enforced seven-minute cap,
// not the account's already-spent product allowance. No shared setting changes.
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
process.env.YTIMESY_MODEL_WORKFLOW_URL = origin;
process.env.YTIMESY_REALTIME_URL = origin;
process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
	await readFile(".ytimesy/realtime-development.json", "utf8"),
).secret;
const realtimeSecret = process.env.YTIMESY_REALTIME_SECRET;
if (!realtimeSecret || realtimeSecret.length < 32)
	throw new Error("Missing realtime proof signing key.");
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Missing Freestyle API key.");
const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const db = database();
const sessions: { userId: string; sessionId: string }[] = [];
let vmId: string | undefined;
let completed = false;
async function turnState(sessionId: string) {
	return (
		await db.query<{
			state: string;
			lease_id: string;
			id: string;
			items: unknown;
		}>(
			"select t.state,t.lease_id,t.id,s.items from api_turn t join agent_session s on s.id=t.session_id where t.session_id=$1 order by t.created_at desc limit 1",
			[sessionId],
		)
	).rows[0];
}
try {
	const owners = (
		await db.query<{ user_id: string }>(
			"select user_id from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
		)
	).rows;
	if (owners.length !== 1)
		throw new Error("Requires one connected subscription owner.");
	const userId = owners[0].user_id;
	const source = (
		await db.query<{
			project_id: string;
			workspace_id: string;
			listed_model_id: string;
			full_name: string;
		}>(
			"select s.project_id,s.workspace_id,s.listed_model_id,p.full_name from agent_session s join project p on p.id=s.project_id where s.user_id=$1 and s.harness='codex' and s.listed_model_id is not null order by s.updated_at desc limit 1",
			[userId],
		)
	).rows[0];
	if (!source)
		throw new Error("No subscription model or project is configured.");
	const apiModel = process.env.EDGE_API_PROOF_MODEL;
	let selectedModel = source.listed_model_id;
	if (apiModel) {
		const connections = await db.query<{ id: string }>(
			"select id from model_connection where user_id=$1 and provider='openrouter'",
			[userId],
		);
		if (connections.rows.length !== 1)
			throw new Error("Requires one saved gateway connection.");
		selectedModel = modelRouteId(connections.rows[0].id, apiModel);
		if (
			!(await apiModelCatalog(userId)).some(
				(model) => model.id === selectedModel,
			)
		)
			throw new Error(
				"Requested proof model is not available; no fallback was used.",
			);
	}
	const sendProofTask = (sessionId: string, text: string) =>
		apiModel
			? sendApiWorkspaceTask(
					{ userId, projectId: source.project_id, sessionId },
					{ modelId: selectedModel, text },
					true,
				)
			: sendSubscriptionTask(
					{ userId, projectId: source.project_id, sessionId },
					{ modelId: selectedModel, variant: "low", text },
					true,
				);
	const name = source.full_name.split("/")[1];
	if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name))
		throw new Error("Invalid fixture directory name.");
	// Execution is permanently enabled by the edge deploy. Confirm it with an
	// unassigned turn; this cannot run inference.
	const url = `${origin}/start`;
	const body = JSON.stringify({
		turnId: randomUUID(),
		leaseId: randomUUID(),
	});
	let ready = false;
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(
				modelWorkflowSigningSecret(),
				"POST",
				url,
				body,
			),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 409) {
			ready = true;
			break;
		}
		if (response.status !== 503)
			throw new Error(`Live gate preflight failed (${response.status}).`);
		await delay(2000);
	}
	if (!ready) throw new Error("Execution gate did not propagate.");
	const parent = await insertAgentSession({
		userId,
		projectId: source.project_id,
		workspaceId: source.workspace_id,
		harness: apiModel ? "api" : "codex",
		title: "Disposable edge proof",
		listedModelId: selectedModel,
	});
	sessions.push({ userId, sessionId: parent.id });
	const created = await client.vms.create({
		slug: `ytimesy-ag-${parent.id.replaceAll("-", "").slice(0, 16)}`,
		snapshotId: CHEAP_BASE_SNAPSHOT,
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 600,
		maxRunTotalSeconds: 420,
		idleTimeoutSeconds: 180,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-edge-live-proof" },
	});
	vmId = created.vmId;
	await saveAgentSessionProviderRef(parent.id, vmId);
	const vm = await waitUntilVmRunning(created.vm, "Cloudflare live proof");
	if (vm.resources.cpu > 2 || vm.resources.memory > 4096)
		throw new Error("Proof VM exceeds the $1 resource envelope.");
	const nonce = randomUUID();
	const setup = await machines.exec(
		WorkspaceId(vmId),
		`mkdir -p "$HOME/${name}" && git -C "$HOME/${name}" init -q && printf '%s\\n' '${nonce}' > "$HOME/${name}/edge-proof.txt" && git -C "$HOME/${name}" add edge-proof.txt && git -C "$HOME/${name}" -c user.name=Proof -c user.email=proof@example.invalid commit -qm fixture && git -C "$HOME/${name}" update-ref refs/ytimesy/base HEAD && printf '%s\\n' "$HOME/${name}" > /tmp/ytimesy-project-cwd`,
		20_000,
	);
	if (setup.exitCode) throw new Error("Disposable fixture setup failed.");
	// A legacy read-only fixture deliberately retains the local prepared checkout.
	await db.query(
		"update agent_session set status='ready',items=$2::jsonb where id=$1",
		[
			parent.id,
			JSON.stringify([
				{
					kind: "userMessage",
					id: randomUUID(),
					text: "Read-only disposable fixture. Never fetch, edit, or publish.",
				},
			]),
		],
	);
	const child = await insertAgentSession({
		userId,
		projectId: source.project_id,
		workspaceId: source.workspace_id,
		harness: apiModel ? "api" : "codex",
		providerRef: vmId,
		parentSessionId: parent.id,
		title: "Read isolated proof marker",
		listedModelId: selectedModel,
		task: {
			prompt: "Read edge-proof.txt",
			placement: "shared",
			access: "read_only",
			execution: "parallel",
			dependsOnSessionId: null,
		},
	});
	sessions.push({ userId, sessionId: child.id });
	// Ingress readiness alone does not establish propagation at the chat DO.
	const readinessId = randomUUID();
	const readinessLease = randomUUID();
	await db.query(
		"insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,lease_id,executor) values($1,$2,$3,null,'routing-proof','routing-proof','completed',$4,'durable-object')",
		[readinessId, child.id, userId, readinessLease],
	);
	const stepUrl = `${origin}/model-step`;
	const readinessBody = JSON.stringify({
		turnId: readinessId,
		leaseId: readinessLease,
		index: 1,
	});
	let chatReady = false;
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(stepUrl, {
			method: "POST",
			body: readinessBody,
			headers: await signDeliveryRequest(
				modelWorkflowSigningSecret(),
				"POST",
				stepUrl,
				readinessBody,
			),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.ok) {
			chatReady = true;
			break;
		}
		if (response.status !== 503)
			throw new Error(`Chat readiness failed (${response.status}).`);
		await delay(2000);
	}
	if (!chatReady) throw new Error("Chat execution gate did not propagate.");
	await db.query("delete from api_turn where id=$1", [readinessId]);
	if (
		process.env.EDGE_CONTROL_PROOF === "1" ||
		process.env.EDGE_RESTART_PROOF === "1"
	) {
		await db.query("update agent_session set task_prompt=$2 where id=$1", [
			child.id,
			"For this isolated transport test, follow the newest user message exactly. Do not use tools, delegate, edit, fetch, or publish. Write the requested long explanation directly.",
		]);
		const previousIds = new Set(
			sessionItemsFromUnknown((await turnState(child.id))?.items).map(
				(item) => item.id,
			),
		);
		await withBackgroundJobDispatcher(
			async () => {},
			() =>
				sendProofTask(
					child.id,
					`This is a cancellation transport test. Without using tools or changing any file, write a detailed ${process.env.EDGE_DEPLOY_PROOF === "1" ? "8000" : "3000"}-word explanation of sorting algorithms. Begin with CANCEL_PROOF_STARTED. Do not create child tasks or publish.`,
				),
		);
		const control = await claimApiTurn(2, 64, "durable-object", child.id);
		if (!control?.lease_id)
			throw new Error("Cancellation proof admission failed.");
		await dispatchModelWorkflow(control);
		const identity = {
			userId,
			sessionId: child.id,
			turnId: control.id,
			leaseId: control.lease_id,
		};
		let observed = false;
		const until = Date.now() + 60_000;
		while (Date.now() < until) {
			const state = await turnState(child.id);
			const streamed = sessionItemsFromUnknown(state?.items).some(
				(item) =>
					!previousIds.has(item.id) &&
					((item.kind === "agentMessage" && item.text.length > 0) ||
						(item.kind === "reasoning" && item.summaries.some(Boolean))),
			);
			if (
				streamed &&
				state?.state === "running" &&
				(await coordinateConversationTurn("renew", identity))
			) {
				observed = true;
				break;
			}
			if (state && !["queued", "running"].includes(state.state)) break;
			await delay(250);
		}
		if (!observed) {
			const state = await turnState(child.id);
			console.info(
				JSON.stringify({
					cancellationAttemptState: state?.state,
					itemKinds: sessionItemsFromUnknown(state?.items).map(
						(item) => item.kind,
					),
					errors: sessionItemsFromUnknown(state?.items)
						.filter((item) => item.kind === "error")
						.map((item) => item.message),
				}),
			);
			throw new Error(
				"No active inference observed; cancellation proof is invalid.",
			);
		}
		if (process.env.EDGE_RESTART_PROOF === "1") {
			async function proofRequest(path: string) {
				const url = `${origin}/proof/${path}`;
				const body = JSON.stringify(identity);
				return fetch(url, {
					method: "POST",
					body,
					headers: await signDeliveryRequest(
						modelWorkflowSigningSecret(),
						"POST",
						url,
						body,
					),
					signal: AbortSignal.timeout(15_000),
				});
			}
			type ReceiptProof = {
				incarnation: string;
				receipts: { index: number; state: string; startedAt: number }[];
			};
			const beforeResponse = await proofRequest("status");
			if (!beforeResponse.ok)
				throw new Error(
					`Recovery fixture is not deployed (${beforeResponse.status}).`,
				);
			const before = (await beforeResponse.json()) as ReceiptProof;
			const uncertain = before.receipts.find(
				(receipt) => receipt.state === "processing",
			);
			if (!uncertain)
				throw new Error("No active model step; restart proof invalid.");
			if (process.env.EDGE_DEPLOY_PROOF === "1") {
				// A real deploy of a new Worker version resets every Durable Object.
				const { execFileSync } = await import("node:child_process");
				execFileSync(
					"pnpm",
					[
						"exec",
						"wrangler",
						"deploy",
						"--config",
						"wrangler.edge-executor.jsonc",
					],
					{
						env: { ...process.env, EDGE_RECOVERY_PROOF_BUILD: "1" },
						stdio: ["ignore", "ignore", "ignore"],
						timeout: 180_000,
					},
				);
			} else {
				const reset = await proofRequest("reset");
				if (reset.ok)
					throw new Error("Expected forced-reset transport failure.");
			}
			const afterResponse = await proofRequest("status");
			if (!afterResponse.ok) throw new Error("Restarted chat unavailable.");
			const after = (await afterResponse.json()) as ReceiptProof;
			// Deploys reach Durable Objects gradually; one may not restart during this step.
			const deployMissed =
				process.env.EDGE_DEPLOY_PROOF === "1" &&
				before.incarnation === after.incarnation;
			if (deployMissed)
				console.info(JSON.stringify({ deployRestartedChatDuringStep: false }));
			// A deploy takes long enough that the resumed step may already be done.
			if (
				(!deployMissed && before.incarnation === after.incarnation) ||
				!after.receipts.some(
					(receipt) =>
						receipt.index === uncertain.index &&
						(receipt.state === "processing" ||
							(process.env.EDGE_DEPLOY_PROOF === "1" &&
								receipt.state === "done")) &&
						receipt.startedAt === uncertain.startedAt,
				)
			)
				throw new Error(
					`Restart did not retain the uncertain receipt: ${JSON.stringify({ restarted: before.incarnation !== after.incarnation, receipts: after.receipts })}`,
				);
			const replayUrl = `${origin}/model-step`;
			const replayBody = JSON.stringify({
				turnId: control.id,
				leaseId: control.lease_id,
				index: uncertain.index,
			});
			const replay = await fetch(replayUrl, {
				method: "POST",
				body: replayBody,
				headers: await signDeliveryRequest(
					modelWorkflowSigningSecret(),
					"POST",
					replayUrl,
					replayBody,
				),
				signal: AbortSignal.timeout(15_000),
			});
			// External callers may never re-run an uncertain step; only the chat resumes it.
			if (replay.status !== 409 && !replay.ok)
				throw new Error("Uncertain model step was not fenced.");
			let resumed = false;
			let resumedTurnState: string | undefined;
			const resumeDeadline = Date.now() + 300_000;
			while (Date.now() < resumeDeadline) {
				// Read the turn first: a terminal turn must already show the resumed receipt.
				const state = await turnState(child.id);
				const status = await proofRequest("status");
				const receipts = status.ok
					? ((await status.json()) as ReceiptProof).receipts
					: [];
				resumed = receipts.some(
					(receipt) =>
						receipt.index === uncertain.index && receipt.state === "done",
				);
				if (resumed) {
					resumedTurnState = state?.state;
					break;
				}
				if (state && !["queued", "running"].includes(state.state))
					throw new Error(
						`Interrupted turn ended as ${state.state} without resuming: ${JSON.stringify(receipts)}`,
					);
				await delay(3000);
			}
			if (!resumed)
				throw new Error("Restarted chat did not resume the interrupted step.");
			console.info(
				JSON.stringify({
					activeInferenceObserved: true,
					durableObjectRestarted: !deployMissed,
					uncertainReceiptPreserved: !deployMissed,
					externalReplayRejected: true,
					interruptedStepResumed: !deployMissed,
					leaseRotatedOnResume:
						(
							await db.query<{ lease_id: string }>(
								"select lease_id from api_turn where id=$1",
								[control.id],
							)
						).rows[0]?.lease_id !== control.lease_id,
					turnStateAfterResume: resumedTurnState,
				}),
			);
			// The long control answer may still be running; stop it before the read proof.
			await cancelServerTurn(userId, child.id);
			const settleDeadline = Date.now() + 60_000;
			while (Date.now() < settleDeadline) {
				const state = await turnState(child.id);
				if (state && !["queued", "running"].includes(state.state)) break;
				await delay(1000);
			}
		} else {
			const stoppedAt = Date.now();
			await cancelServerTurn(userId, child.id);
			if (await coordinateConversationTurn("renew", identity))
				throw new Error("Cancelled lease still renews.");
			let stopped = false;
			while (Date.now() - stoppedAt < 45_000) {
				const state = await turnState(child.id);
				if (state?.state === "cancelled") {
					stopped = true;
					break;
				}
				if (state && !["queued", "running"].includes(state.state))
					throw new Error(
						"Cancelled inference ended with an unexpected state.",
					);
				await delay(500);
			}
			if (!stopped)
				throw new Error("Cancellation did not settle before its deadline.");
			console.info(
				JSON.stringify({
					activeInferenceObserved: true,
					cancellationFenced: true,
					cancellationSettledMs: Date.now() - stoppedAt,
				}),
			);
		}
	}
	await db.query(
		"update agent_session set task_prompt='Read edge-proof.txt' where id=$1",
		[child.id],
	);
	const started = Date.now();
	// Suppress global admission: claim only after ensuring the development queue is empty.
	let pending = await db.query(
		"select 1 from api_turn where state in ('queued','running') limit 1",
	);
	for (let wait = 0; pending.rowCount && wait < 30; wait++) {
		await delay(2000);
		pending = await db.query(
			"select 1 from api_turn where state in ('queued','running') limit 1",
		);
	}
	if (pending.rowCount)
		throw new Error("Other active turns exist; isolated admission refused.");
	await withBackgroundJobDispatcher(
		async () => {},
		() =>
			sendProofTask(
				child.id,
				"Read edge-proof.txt using the read_file tool. Reply with its exact content and EDGE_TOOL_PROOF_COMPLETE. It contains a random marker not supplied in this prompt. This is a read-only transport test: do not edit, fetch, publish, or create child tasks. Use no more than two repository tools.",
			),
	);
	const turn = await claimApiTurn(2, 64, "durable-object", child.id);
	if (turn) {
		if (turn.session_id !== child.id || !turn.lease_id)
			throw new Error("Isolated turn admission failed.");
		await dispatchModelWorkflow(turn);
	} else if (
		// A chat that just finished a turn admits the next queued message itself.
		!(
			await db.query(
				"select 1 from api_turn where session_id=$1 and state='running' and executor='durable-object'",
				[child.id],
			)
		).rowCount
	)
		throw new Error("Isolated turn admission failed.");
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const state = await turnState(child.id);
		if (state && !["queued", "running"].includes(state.state)) {
			const items = sessionItemsFromUnknown(state.items);
			const text = items
				.filter((item) => item.kind === "agentMessage")
				.map((item) => item.text)
				.join("\n");
			const tools = items.filter(
				(item) =>
					item.kind === "mcpToolCall" ||
					item.kind === "commandExecution" ||
					item.kind === "dynamicToolCall",
			);
			const toolReadVerified = tools.some(
				(item) =>
					(item.kind === "dynamicToolCall" ||
						item.kind === "commandExecution") &&
					item.status === "completed" &&
					item.output?.includes(nonce),
			);
			const latestPrompt = [...items]
				.reverse()
				.find((item) => item.kind === "userMessage");
			const usage =
				latestPrompt?.kind === "userMessage" ? latestPrompt.apiUsage : null;
			const context =
				latestPrompt?.kind === "userMessage"
					? latestPrompt.contextUsage?.context
					: null;
			console.info(
				JSON.stringify({
					state: state.state,
					elapsedMs: Date.now() - started,
					model: apiModel ?? source.listed_model_id,
					toolCards: tools.length,
					toolReadVerified,
					markerVerified: text.includes(nonce),
					completionMarker: text.includes("EDGE_TOOL_PROOF_COMPLETE"),
					usageRecorded: items.some(
						(item) => item.kind === "userMessage" && !!item.apiUsage,
					),
					usage,
					contextRecorded: !!context,
					failureMessages: items
						.filter((item) => item.kind === "error")
						.map((item) => item.message),
				}),
			);
			if (
				state.state !== "completed" ||
				!text.includes(nonce) ||
				!text.includes("EDGE_TOOL_PROOF_COMPLETE") ||
				tools.length === 0 ||
				!toolReadVerified ||
				!usage ||
				!(usage.inputTokens && usage.inputTokens > 0) ||
				!(usage.outputTokens && usage.outputTokens > 0) ||
				!context
			)
				throw new Error(
					"Live model/tool proof failed; inspect persisted isolated trace.",
				);
			const streamUrl = `${origin}/stream?${new URLSearchParams({ userId, sessionId: child.id, displaySessionId: child.id, revision: "1" })}`;
			const stream = await fetch(streamUrl, {
				headers: await signDeliveryRequest(realtimeSecret, "GET", streamUrl),
				signal: AbortSignal.timeout(10_000),
			});
			console.info(JSON.stringify({ chatStreamStatus: stream.status }));
			const delivery = await db.query<{
				revision: string;
				delivered_revision: string;
				attempts: number;
				leased: boolean;
			}>(
				"select revision::text,delivered_revision::text,attempts,lease_id is not null as leased from conversation_delivery where session_id=$1",
				[child.id],
			);
			console.info(JSON.stringify({ chatDelivery: delivery.rows[0] ?? null }));
			if (!stream.ok || !stream.body)
				throw new Error("Deployed chat stream unavailable.");
			const reader = stream.body.getReader();
			let receivedFinal = false;
			let bytes = 0;
			const decoder = new TextDecoder();
			const parser = createParser({
				onEvent(event) {
					if (event.event !== "progress") return;
					try {
						receivedFinal ||= verifiedEdgeProofProgress(
							JSON.parse(event.data),
							nonce,
						);
					} catch {}
				},
			});
			try {
				while (!receivedFinal) {
					const chunk = await reader.read();
					if (chunk.done)
						throw new Error("Chat stream omitted the final response.");
					bytes += chunk.value.byteLength;
					if (bytes > 8 * 1024 * 1024)
						throw new Error("Proof stream exceeded the byte limit.");
					parser.feed(decoder.decode(chunk.value, { stream: true }));
				}
			} finally {
				await reader.cancel();
			}
			console.info(JSON.stringify({ deployedChatStreamVerified: true }));
			completed = true;
			break;
		}
		await delay(1000);
	}
	if (!completed)
		throw new Error("Live proof exceeded its three-minute deadline.");
} finally {
	for (const session of sessions.slice().reverse())
		await cancelServerTurn(session.userId, session.sessionId).catch(() => {});
	const cleanupFailures: string[] = [];
	async function clean(label: string, run: () => unknown | Promise<unknown>) {
		try {
			await run();
		} catch {
			cleanupFailures.push(label);
		}
	}
	if (vmId) {
		const proofVmId = vmId;
		await clean("proof VM", async () => {
			await client.vms.delete(proofVmId);
			console.info("Disposable proof VM deleted.");
		});
	}
	for (const session of sessions.slice().reverse())
		await clean("proof session", () =>
			deleteAgentSessionForOwner(session.userId, session.sessionId),
		);
	await closeDatabase();
	if (cleanupFailures.length) {
		console.error(`Proof cleanup incomplete: ${cleanupFailures.join(", ")}.`);
		process.exitCode = 1;
	} else console.info("Isolated proof sessions removed.");
}
