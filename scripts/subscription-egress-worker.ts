import { readBoundedRequestBody } from "../src/domain/bounded-request-body";
import { verifyDeliveryRequest } from "../src/domain/delivery-auth";
import { probeSubscription } from "./subscription-egress-probe";

type Environment = {
	EGRESS?: { fetch: typeof fetch };
	REQUIRE_VPC?: string;
	PROBE_SECRET?: string;
	PROBE_ACCESS_TOKEN?: string;
	PROBE_ACCOUNT_ID?: string;
	PROBE_MODEL?: string;
	PROBE_EXPIRES?: string;
};

export default {
	async fetch(request: Request, env: Environment) {
		if (new URL(request.url).pathname === "/readiness")
			return Response.json({
				vpc: Boolean(env.EGRESS),
				fetch: typeof env.EGRESS?.fetch,
			});
		if (env.REQUIRE_VPC === "1" && !env.EGRESS)
			return new Response(null, { status: 503 });
		if (
			!env.PROBE_SECRET ||
			!env.PROBE_ACCESS_TOKEN ||
			!env.PROBE_ACCOUNT_ID ||
			!env.PROBE_MODEL ||
			Number(env.PROBE_EXPIRES ?? 0) < Date.now()
		)
			return new Response(null, { status: 503 });
		if (
			request.method !== "POST" ||
			!["/catalog", "/inference"].includes(new URL(request.url).pathname)
		)
			return new Response(null, { status: 404 });
		try {
			if ((await readBoundedRequestBody(request, 1)) !== "")
				return new Response(null, { status: 400 });
		} catch {
			return new Response(null, { status: 400 });
		}
		if (!(await verifyDeliveryRequest(env.PROBE_SECRET, request, "")))
			return new Response(null, { status: 401 });
		const egress = env.EGRESS;
		return Response.json(
			await probeSubscription(
				{
					accessToken: env.PROBE_ACCESS_TOKEN,
					accountId: env.PROBE_ACCOUNT_ID,
					model: env.PROBE_MODEL,
				},
				new URL(request.url).pathname === "/inference",
				egress ? (input, options) => egress.fetch(input, options) : fetch,
			),
			{ headers: { "Cache-Control": "no-store" } },
		);
	},
};
