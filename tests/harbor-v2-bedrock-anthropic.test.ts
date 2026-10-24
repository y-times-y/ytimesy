import { describe, expect, it } from "vitest";
import {
	bedrockAnthropicProfile,
	bedrockModelId,
} from "../evals/harbor_v2/bedrock";
import {
	anthropicClientModel,
	BEDROCK_ANTHROPIC_BASE_URL,
	bedrockAnthropicBody,
	bedrockAnthropicFetch,
	decodeEventStream,
	eventMessageSse,
} from "../evals/harbor_v2/bedrock-anthropic";

/** One AWS event-stream message with string headers (CRCs left zero: the decoder does not check them). */
function frame(headers: Record<string, string>, payload: string) {
	const encoder = new TextEncoder();
	const headerBytes = Object.entries(headers).flatMap(([name, value]) => {
		const n = encoder.encode(name);
		const v = encoder.encode(value);
		return [n.length, ...n, 7, v.length >> 8, v.length & 255, ...v];
	});
	const body = encoder.encode(payload);
	const total = 12 + headerBytes.length + body.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total);
	view.setUint32(4, headerBytes.length);
	out.set(headerBytes, 12);
	out.set(body, 12 + headerBytes.length);
	return out;
}

const chunk = (event: object) =>
	frame(
		{ ":message-type": "event", ":event-type": "chunk" },
		JSON.stringify({
			bytes: Buffer.from(JSON.stringify(event)).toString("base64"),
		}),
	);

describe("Bedrock Claude ids", () => {
	it("maps foundation ids to the global profile and keeps profile ids", () => {
		expect(bedrockAnthropicProfile("anthropic.claude-haiku-5-5")).toBe(
			"global.anthropic.claude-haiku-5-5",
		);
		expect(bedrockAnthropicProfile("us.anthropic.claude-haiku-5-5")).toBe(
			"us.anthropic.claude-haiku-5-5",
		);
		expect(bedrockAnthropicProfile("openai.gpt-6.1-sol")).toBeNull();
		expect(
			bedrockModelId("anthropic.claude-haiku-5-5", {
				endpoint: "mantle",
				profile: "global",
			}),
		).toBe("global.anthropic.claude-haiku-5-5");
		expect(anthropicClientModel("global.anthropic.claude-haiku-5-5")).toBe(
			"claude-haiku-5-5",
		);
	});
});

describe("bedrockAnthropicBody", () => {
	it("drops model and stream, adds the Bedrock version and betas", () => {
		const body = JSON.parse(
			bedrockAnthropicBody(
				JSON.stringify({
					model: "claude-haiku-5-5",
					stream: true,
					max_tokens: 10,
					messages: [],
				}),
				"beta-a, beta-b",
			),
		);
		expect(body).toEqual({
			anthropic_version: "bedrock-2023-05-31",
			anthropic_beta: ["beta-a", "beta-b"],
			max_tokens: 10,
			messages: [],
		});
	});
});

describe("decodeEventStream", () => {
	it("splits whole messages and keeps a partial one for the next chunk", () => {
		const first = chunk({ type: "message_start", message: {} });
		const second = chunk({ type: "message_stop" });
		const joined = new Uint8Array(first.length + second.length);
		joined.set(first);
		joined.set(second, first.length);
		const cut = joined.subarray(0, first.length + 5);
		const { messages, rest } = decodeEventStream(cut);
		expect(messages).toHaveLength(1);
		expect(rest).toHaveLength(5);
		expect(eventMessageSse(messages[0])).toBe(
			'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
		);
	});

	it("turns an exception into an SSE error event", () => {
		const { messages } = decodeEventStream(
			frame(
				{
					":message-type": "exception",
					":exception-type": "throttlingException",
				},
				'{"message":"slow down"}',
			),
		);
		expect(eventMessageSse(messages[0])).toContain(
			'"type":"throttlingException"',
		);
	});
});

describe("bedrockAnthropicFetch", () => {
	it("signs a Messages request to bedrock-runtime and streams SSE back", async () => {
		const sent: { url: string; headers: Headers; body: string }[] = [];
		const fetch = bedrockAnthropicFetch({
			credentials: { accessKeyId: "AKIAEXAMPLEEXAMPLE", secretAccessKey: "x" },
			region: "us-east-1",
			profile: "global.anthropic.claude-haiku-5-5",
			now: () => new Date("2026-10-24T00:00:00Z"),
			fetch: async (url, init) => {
				sent.push({
					url: String(url),
					headers: new Headers(init?.headers),
					body: String(init?.body),
				});
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(chunk({ type: "message_stop" }));
							controller.close();
						},
					}),
				);
			},
		});
		const response = await fetch(`${BEDROCK_ANTHROPIC_BASE_URL}/messages`, {
			method: "POST",
			headers: { "anthropic-beta": "beta-a" },
			body: JSON.stringify({ model: "claude-haiku-5-5", stream: true }),
		});
		expect(sent[0].url).toBe(
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-haiku-5-5/invoke-with-response-stream",
		);
		expect(sent[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
		expect(JSON.parse(sent[0].body).anthropic_beta).toEqual(["beta-a"]);
		expect(await response.text()).toBe(
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		);
		await expect(fetch("https://example.com/v1/models", {})).rejects.toThrow(
			/only sends Messages requests/,
		);
	});
});
