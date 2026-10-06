import { createServer } from "node:http";
import { applyApiProgress } from "#/domain/api-progress";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import { verifyDeliveryRequest } from "#/domain/delivery-auth";
import {
	MAX_WORKFLOW_MODEL_STEPS,
	workflowStepSchema,
} from "#/domain/model-workflow";
import { prRepairDelivery } from "#/domain/pr-repair-signal";
import { finalizeApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { modelWorkflowSigningSecret } from "../adapters/model-workflow-dispatch";
import {
	claimModelWorkflowStep,
	completeModelWorkflowStep,
} from "../adapters/model-workflow-steps";
import { stageVerifiedPrRepairSignal } from "../services/pr-repair-webhook";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

/** Only signed reference-only requests reach the existing owner-scoped execution path. */
export async function executeWorkflowRequest(
	request: Request,
	secret: string,
	machines: WorkspaceMachines | (() => WorkspaceMachines),
) {
	const path = new URL(request.url).pathname;
	if (
		request.method !== "POST" ||
		!["/model-step", "/pr-repair-event"].includes(path)
	)
		return new Response(null, { status: 404 });
	let body: string;
	try {
		body = await readBoundedRequestBody(request, 1024);
	} catch {
		return new Response(null, { status: 413 });
	}
	if (!(await verifyDeliveryRequest(secret, request, body)))
		return new Response(null, { status: 401 });
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return new Response(null, { status: 400 });
	}
	if (path === "/pr-repair-event") {
		if (process.env.YTIMESY_PR_REPAIR_ENABLED !== "1")
			return new Response(null, { status: 503 });
		const delivery = prRepairDelivery.safeParse(value);
		if (!delivery.success) return new Response(null, { status: 400 });
		await stageVerifiedPrRepairSignal(
			delivery.data.deliveryId,
			delivery.data.signal,
		);
		return Response.json({ accepted: true });
	}
	const parsed = workflowStepSchema.safeParse(value);
	if (!parsed.success) return new Response(null, { status: 400 });
	const claim = await claimModelWorkflowStep(parsed.data);
	if (claim.kind === "unavailable") return new Response(null, { status: 409 });
	if (claim.kind === "done") return Response.json({ outcome: claim.outcome });
	if (claim.kind === "cancelled") {
		const items = applyApiProgress(claim.turn.items, claim.turn.id, {
			type: "finish",
			reason: "cancelled",
			inputTokens: null,
			outputTokens: null,
		});
		const saved = await finalizeApiTurn(claim.turn, "cancelled", items);
		if (saved !== "cancelled") return new Response(null, { status: 409 });
		await coordinateConversationTurn("release", {
			userId: claim.turn.user_id,
			sessionId: claim.turn.session_id,
			turnId: claim.turn.id,
			leaseId: parsed.data.leaseId,
		}).catch(() => {});
		return Response.json({ outcome: "cancelled" });
	}
	const expired = new AbortController();
	if (claim.remainingMs === 0) expired.abort();
	const signal = AbortSignal.any([
		request.signal,
		expired.signal,
		AbortSignal.timeout(claim.remainingMs),
	]);
	const outcome = await runApiTurn(
		typeof machines === "function" ? machines() : machines,
		claim.turn,
		{
			index: parsed.data.index,
			signal,
			limitReached: parsed.data.index > MAX_WORKFLOW_MODEL_STEPS,
		},
	);
	await completeModelWorkflowStep(parsed.data, outcome);
	return Response.json({ outcome });
}

/** A transport/execution service, not an in-memory workflow registry. No model history crosses HTTP. */
export async function startModelWorkflowExecutor(machines: WorkspaceMachines) {
	const secret = modelWorkflowSigningSecret();
	const port = Number(process.env.YTIMESY_MODEL_EXECUTOR_PORT ?? 8789);
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		throw new Error("Invalid model executor port.");
	const server = createServer(async (incoming, outgoing) => {
		const disconnected = new AbortController();
		outgoing.on("close", () => {
			if (!outgoing.writableEnded) disconnected.abort();
		});
		try {
			const parts: Buffer[] = [];
			let length = 0;
			for await (const part of incoming) {
				length += part.length;
				if (length > 1024) {
					outgoing.writeHead(413).end();
					return;
				}
				parts.push(part);
			}
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers))
				if (typeof value === "string") headers.set(name, value);
			const response = await executeWorkflowRequest(
				new Request(`http://executor.local${incoming.url}`, {
					method: incoming.method,
					headers,
					...(incoming.method === "POST"
						? { body: Buffer.concat(parts).toString("utf8") }
						: {}),
					signal: disconnected.signal,
				}),
				secret,
				machines,
			);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(await response.text());
		} catch {
			// Provider/SQL failures may include credentials; never serialize their raw messages.
			outgoing.writeHead(503).end();
		}
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "0.0.0.0", resolve);
	});
	return () =>
		new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
}
