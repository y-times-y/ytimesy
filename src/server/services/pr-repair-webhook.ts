import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import {
	type GitHubPrSignal,
	isPrCommentSignal,
	parsePrRepairSignal,
} from "#/domain/pr-repair-signal";
import { stagePullRequestWakes } from "../adapters/pull-request-links";
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
		process.env.GITHUB_APP_SLUG,
	);
	if (!signal) return Response.json({ accepted: true, ignored: true });
	await stageVerifiedPrRepairSignal(deliveryId.data, signal);
	return Response.json({ accepted: true });
}

/** Called only after GitHub authentication or the authenticated development bridge. */
export async function stageVerifiedPrRepairSignal(
	deliveryId: string,
	signal: GitHubPrSignal,
) {
	if (isPrCommentSignal(signal)) {
		await stagePullRequestWakes({
			repositoryId: signal.repositoryId,
			installationId: signal.installationId,
			pullNumbers: [signal.prNumber],
			deliveryId,
			kind: signal.kind,
			sourceId: signal.sourceId,
			headSha: null,
		});
		await enqueuePrRepair();
		return;
	}
	// A failed check on a pull request ytimesy opened from a chat wakes that chat.
	if (signal.kind !== "review")
		await stagePullRequestWakes({
			repositoryId: signal.repositoryId,
			installationId: signal.installationId,
			pullNumbers: signal.prNumbers,
			deliveryId,
			kind: "ci",
			sourceId: signal.sourceId,
			headSha: signal.headSha,
		});
	await enqueuePrRepair();
}
