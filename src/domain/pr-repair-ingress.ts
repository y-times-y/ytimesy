import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import { readBoundedRequestBody } from "./bounded-request-body";
import { parsePrRepairSignal, type prRepairDelivery } from "./pr-repair-signal";

/** The development edge executor Worker (wrangler.edge-executor.jsonc) on the team's workers.dev subdomain. */
const EDGE_EXECUTOR_HOST =
	"ytimesy-edge-executor-development.example-account.workers.dev";
/** Retired Freestyle model-executor VMs, kept so an older ingress deploy stays valid. */
const FREESTYLE_EXECUTOR_HOST =
	/^ytimesy-model-executor-(?:vm)?[a-f0-9]{32}\.style\.dev$/;

export function prRepairExecutorUrl(origin: string) {
	const target = new URL(origin);
	if (
		target.protocol !== "https:" ||
		target.username ||
		target.password ||
		target.port ||
		target.pathname !== "/" ||
		target.search ||
		target.hash ||
		(target.hostname !== EDGE_EXECUTOR_HOST &&
			!FREESTYLE_EXECUTOR_HOST.test(target.hostname))
	)
		throw new Error("Not an approved development executor.");
	return new URL("/pr-repair-event", target).href;
}

/** Authenticate raw bytes before retaining minimal identifiers for a later GitHub re-fetch. */
export async function acceptPrRepairWebhook(
	request: Request,
	secret: string,
	schedule: (delivery: z.infer<typeof prRepairDelivery>) => Promise<void>,
	/** The App's slug: comments that mention `@<slug>` wake a chat. */
	appSlug?: string | null,
) {
	if (
		request.method !== "POST" ||
		new URL(request.url).pathname !== "/github-repair"
	)
		return new Response(null, { status: 404 });
	if (!secret) return new Response(null, { status: 503 });
	const delivery = z.uuid().safeParse(request.headers.get("x-github-delivery"));
	const signature = request.headers.get("x-hub-signature-256") ?? "";
	if (!delivery.success || !/^sha256=[a-f0-9]{64}$/.test(signature))
		return new Response(null, { status: 401 });
	let body: string;
	try {
		body = await readBoundedRequestBody(request, 1_000_000);
	} catch {
		return new Response(null, { status: 413 });
	}
	if (!(await new Webhooks({ secret }).verify(body, signature)))
		return new Response(null, { status: 401 });
	let signal: ReturnType<typeof parsePrRepairSignal>;
	try {
		signal = parsePrRepairSignal(
			request.headers.get("x-github-event") ?? "",
			JSON.parse(body),
			appSlug,
		);
	} catch {
		return new Response(null, { status: 400 });
	}
	if (!signal) return Response.json({ accepted: true, ignored: true });
	try {
		await schedule({ deliveryId: delivery.data, signal });
	} catch {
		return new Response(null, { status: 503 });
	}
	return Response.json({ accepted: true }, { status: 202 });
}
