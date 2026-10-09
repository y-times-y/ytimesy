import { readBoundedRequestBody } from "../src/domain/bounded-request-body";
import { PINNED_CODEX_CLI_VERSION } from "../src/domain/guest-cli-pin";

export type ProbeConnection = {
	accessToken: string;
	accountId: string;
	model: string;
};

/** Fixed endpoints and tiny input only. Never returns upstream text or identifiers. */
export async function probeSubscription(
	connection: ProbeConnection,
	inference: boolean,
	request: typeof fetch = fetch,
) {
	const started = Date.now();
	const endpoint = inference
		? "codex/responses"
		: `codex/models?client_version=${PINNED_CODEX_CLI_VERSION}`;
	const headers = {
		Authorization: `Bearer ${connection.accessToken}`,
		"ChatGPT-Account-ID": connection.accountId,
		"User-Agent": "ytimesy/1.0",
		Accept: inference ? "text/event-stream" : "application/json",
		"Content-Type": "application/json",
	};
	try {
		const response = await request(
			`https://chatgpt.com/backend-api/${endpoint}`,
			{
				method: inference ? "POST" : "GET",
				headers,
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
				...(inference
					? {
							body: JSON.stringify({
								model: connection.model,
								instructions: "Reply with OK only.",
								input: [
									{
										role: "user",
										content: [{ type: "input_text", text: "Hello" }],
									},
								],
								store: false,
								stream: true,
								reasoning: { effort: "low", summary: "auto" },
							}),
						}
					: {}),
			},
		);
		let body = "";
		try {
			body = await readBoundedRequestBody(response, 2 * 1024 * 1024);
		} catch {
			return {
				status: response.status,
				category: "unreadable-body",
				elapsedMs: Date.now() - started,
			};
		}
		const contentType = response.headers.get("content-type") ?? "";
		let code = "unknown";
		try {
			const parsed = JSON.parse(body);
			const candidate = parsed?.error?.code ?? parsed?.error?.type;
			if (
				[
					"unsupported_country_region_territory",
					"invalid_api_key",
					"insufficient_quota",
					"model_not_found",
					"invalid_request_error",
					"account_deactivated",
					"token_expired",
				].includes(candidate)
			)
				code = candidate;
		} catch {
			/* Non-JSON responses are categorized without exposing text. */
		}
		return {
			status: response.status,
			category:
				response.headers.get("cf-mitigated") === "challenge"
					? "access-challenge"
					: contentType.includes("text/html")
						? "html"
						: contentType.includes("json")
							? "json"
							: contentType.includes("event-stream")
								? "sse"
								: "other",
			code,
			cloudflareError: /error\s*(?:code[:\s]*)?\s*1020/i.test(body)
				? 1020
				: /error\s*(?:code[:\s]*)?\s*1010/i.test(body)
					? 1010
					: null,
			completed: inference && body.includes('"type":"response.completed"'),
			elapsedMs: Date.now() - started,
		};
	} catch {
		return {
			status: null,
			category: "transport",
			elapsedMs: Date.now() - started,
		};
	}
}
