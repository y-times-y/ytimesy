import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import {
	type PrRepairSignal,
	parsePrRepairSignal,
} from "#/domain/pr-repair-signal";
import { database } from "../adapters/database";
import { enqueuePrRepair } from "../jobs/queue";

/** Fail closed unless explicitly enabled and signed; never log raw webhook payloads. */
export async function receivePrRepairWebhook(request: Request) {
	const secret = process.env.GITHUB_PR_REPAIR_WEBHOOK_SECRET;
	if (process.env.YTIMESY_PR_REPAIR_ENABLED !== "1" || !secret)
		return new Response("Not enabled", { status: 503 });
	const deliveryId = z
		.uuid()
		.safeParse(request.headers.get("x-github-delivery"));
	const signature = request.headers.get("x-hub-signature-256") ?? "";
	if (!deliveryId.success || !/^sha256=[a-f0-9]{64}$/.test(signature))
		return new Response("Invalid delivery", { status: 401 });
	let body: string;
	try {
		body = await readBoundedRequestBody(request, 1_000_000);
	} catch (error) {
		return new Response("Invalid request body", {
			status: error instanceof RangeError ? 413 : 400,
		});
	}
	if (!(await new Webhooks({ secret }).verify(body, signature)))
		return new Response("Invalid signature", { status: 401 });
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	const signal = parsePrRepairSignal(
		request.headers.get("x-github-event") ?? "",
		payload,
	);
	if (!signal) return Response.json({ accepted: true, ignored: true });
	await stageVerifiedPrRepairSignal(deliveryId.data, signal);
	return Response.json({ accepted: true });
}

/** Called only after GitHub authentication or the authenticated development bridge. */
export async function stageVerifiedPrRepairSignal(
	deliveryId: string,
	signal: PrRepairSignal,
) {
	const candidates = await database().query<{ id: string }>(
		`select s.id from agent_session s join project p on p.id=s.project_id and p.user_id=s.user_id
		join project_repository r on r.project_id=p.id and r.repository_id::bigint=$1
		where s.task_access='read_write' and s.harness in ('api','codex') and s.parent_session_id is not null
		and s.task_pull_request_url like $2 and ($3::bigint is null or r.installation_id::bigint=$3)`,
		[
			signal.repositoryId,
			`https://github.com/${signal.fullName}/pull/%`,
			signal.installationId,
		],
	);
	for (const candidate of candidates.rows) {
		await database().query(
			`insert into agent_pr_repair_event(delivery_id,session_id,head_sha,signal) values($1,$2,$3,$4) on conflict do nothing`,
			[deliveryId, candidate.id, signal.headSha, JSON.stringify(signal)],
		);
	}
	await enqueuePrRepair();
}
