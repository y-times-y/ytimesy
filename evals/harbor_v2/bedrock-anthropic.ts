import { type AwsCredentials, signAwsRequest } from "./bedrock";

/**
 * Claude models in Amazon Bedrock for the Harbor bridge (route `bedrock`, a
 * role model such as `roleModels.checker=bedrock:anthropic.claude-haiku-5-5`).
 *
 * The product's Anthropic Messages runtime (apiModelRuntime, provider
 * "anthropic") runs unchanged against a placeholder base URL; this fetch
 * turns each Messages request into Bedrock's InvokeModelWithResponseStream on
 * bedrock-runtime (body: `anthropic_version` and `anthropic_beta` in place of
 * the model, stream flag and beta header), signs it with SigV4 (service
 * `bedrock`), and turns Bedrock's binary event stream back into the
 * Messages API's server-sent events. Claude on Bedrock is served by an
 * inference profile (`global.anthropic.claude-haiku-5-5`).
 */

/** The base URL the Anthropic client is given; only this fetch reads it. */
export const BEDROCK_ANTHROPIC_BASE_URL =
	"https://bedrock-anthropic.invalid/v1";

/** The Anthropic API's own id for a Bedrock Claude id (claude-haiku-5-5). */
export function anthropicClientModel(profile: string) {
	return profile.slice(profile.indexOf("anthropic.") + "anthropic.".length);
}

/** The Messages request body as Bedrock's InvokeModel takes it. */
export function bedrockAnthropicBody(body: string, betaHeader: string | null) {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	delete parsed.model;
	delete parsed.stream;
	const betas = (betaHeader ?? "")
		.split(",")
		.map((beta) => beta.trim())
		.filter(Boolean);
	return JSON.stringify({
		anthropic_version: "bedrock-2023-05-31",
		...(betas.length ? { anthropic_beta: betas } : {}),
		...parsed,
	});
}

type EventMessage = {
	headers: Record<string, string>;
	payload: Uint8Array;
};

/**
 * Splits AWS event-stream bytes into messages (prelude: total and header
 * lengths and a CRC; string headers; payload; message CRC). Returns the
 * whole messages and the bytes left over for the next chunk.
 */
export function decodeEventStream(buffer: Uint8Array): {
	messages: EventMessage[];
	rest: Uint8Array;
} {
	const messages: EventMessage[] = [];
	let offset = 0;
	while (buffer.length - offset >= 12) {
		const view = new DataView(
			buffer.buffer,
			buffer.byteOffset + offset,
			buffer.length - offset,
		);
		const total = view.getUint32(0);
		const headerLength = view.getUint32(4);
		if (total < 16 || buffer.length - offset < total) break;
		const headers: Record<string, string> = {};
		let at = offset + 12;
		const headerEnd = at + headerLength;
		while (at < headerEnd) {
			const nameLength = buffer[at];
			const name = new TextDecoder().decode(
				buffer.subarray(at + 1, at + 1 + nameLength),
			);
			at += 1 + nameLength;
			const type = buffer[at];
			at += 1;
			if (type !== 7)
				throw new Error(`Unsupported event-stream header type ${type}.`);
			const valueLength = (buffer[at] << 8) | buffer[at + 1];
			headers[name] = new TextDecoder().decode(
				buffer.subarray(at + 2, at + 2 + valueLength),
			);
			at += 2 + valueLength;
		}
		messages.push({
			headers,
			payload: buffer.slice(headerEnd, offset + total - 4),
		});
		offset += total;
	}
	return { messages, rest: buffer.slice(offset) };
}

/** One event-stream message as Messages API server-sent events, or an error. */
export function eventMessageSse(message: EventMessage): string {
	const kind = message.headers[":message-type"];
	const text = new TextDecoder().decode(message.payload);
	if (kind === "exception" || kind === "error") {
		const type =
			message.headers[":exception-type"] ??
			message.headers[":error-code"] ??
			"error";
		return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: text.slice(0, 2000) } })}\n\n`;
	}
	if (message.headers[":event-type"] !== "chunk") return "";
	const chunk = JSON.parse(text) as { bytes?: string };
	if (!chunk.bytes) return "";
	const json = Buffer.from(chunk.bytes, "base64").toString("utf8");
	const event = JSON.parse(json) as { type?: string };
	return `event: ${event.type ?? "message"}\ndata: ${json}\n\n`;
}

function sseStream(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	let pending: Uint8Array = new Uint8Array(0);
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				const joined = new Uint8Array(pending.length + value.length);
				joined.set(pending);
				joined.set(value, pending.length);
				const { messages, rest } = decodeEventStream(joined);
				pending = rest;
				const text = messages.map(eventMessageSse).join("");
				if (text) {
					controller.enqueue(encoder.encode(text));
					return;
				}
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * The fetch the Anthropic client uses on the bedrock route: Messages
 * requests to BEDROCK_ANTHROPIC_BASE_URL go to Bedrock as the given profile;
 * nothing else is sent.
 */
export function bedrockAnthropicFetch(input: {
	credentials: AwsCredentials;
	region: string;
	profile: string;
	fetch: typeof globalThis.fetch;
	now?: () => Date;
}): typeof globalThis.fetch {
	const messagesUrl = `${BEDROCK_ANTHROPIC_BASE_URL}/messages`;
	return async (request, init) => {
		const url =
			typeof request === "string"
				? request
				: request instanceof URL
					? request.href
					: request.url;
		if (url !== messagesUrl)
			throw new Error(
				`The Bedrock Claude route only sends Messages requests (got ${url}).`,
			);
		const original = init?.body ?? "";
		if (typeof original !== "string")
			throw new Error("The Bedrock route signs string request bodies only.");
		const incoming = new Headers(init?.headers);
		const streaming = (JSON.parse(original) as { stream?: unknown }).stream;
		const body = bedrockAnthropicBody(original, incoming.get("anthropic-beta"));
		const target = `https://bedrock-runtime.${input.region}.amazonaws.com/model/${encodeURIComponent(input.profile)}/${streaming ? "invoke-with-response-stream" : "invoke"}`;
		const headers = new Headers({
			"content-type": "application/json",
			accept: streaming
				? "application/vnd.amazon.eventstream"
				: "application/json",
		});
		for (const [name, value] of Object.entries(
			signAwsRequest({
				method: "POST",
				url: target,
				body,
				credentials: input.credentials,
				region: input.region,
				service: "bedrock",
				now: input.now?.(),
			}),
		))
			headers.set(name, value);
		const response = await input.fetch(target, {
			method: "POST",
			headers,
			body,
			signal: init?.signal,
		});
		if (!response.ok || !streaming || !response.body) return response;
		return new Response(sseStream(response.body), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
}
