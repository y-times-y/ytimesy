import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { afterEach, expect, it } from "vitest";
import {
	BEDROCK_MANTLE_BASE_URL,
	bedrockClaudeRuntime,
	estimatedOpusCostUsd,
} from "../benchmarks/evaluation/bedrock-claude";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function keyFile(contents: string) {
	directory = await mkdtemp(join(tmpdir(), "bedrock-key-"));
	const path = join(directory, "key");
	await writeFile(path, contents);
	return path;
}

it("calls Opus 5.5 on Bedrock at max effort with caching and the key as x-api-key", async () => {
	const requests: {
		url: string;
		headers: Headers;
		body: Record<string, unknown>;
	}[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		requests.push({
			url: String(url),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)),
		});
		return Response.json({
			id: "msg_fixture",
			type: "message",
			role: "assistant",
			model: "anthropic.claude-opus-5-5",
			content: [{ type: "text", text: "OK" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 3, output_tokens: 1 },
		});
	};
	const runtime = await bedrockClaudeRuntime({
		modelId: "anthropic.claude-opus-5-5",
		effort: "max",
		keyFile: await keyFile("bedrock-api-key-fixture\n"),
		fetch,
	});
	await generateText({
		model: runtime.model,
		...runtime.requestSettings?.("Stable instructions"),
		prompt: "Say OK",
	});
	const [request] = requests;
	expect(request.url).toBe(`${BEDROCK_MANTLE_BASE_URL}/messages`);
	expect(request.headers.get("x-api-key")).toBe("bedrock-api-key-fixture");
	expect(request.body.model).toBe("anthropic.claude-opus-5-5");
	expect(request.body.output_config).toMatchObject({ effort: "max" });
	expect(request.body.cache_control).toEqual({ type: "ephemeral" });
	expect(request.body).not.toHaveProperty("speed");
	expect(runtime.maxOutputTokens).toBe(64_000);
});

it("refuses a key that is not a Bedrock API key", async () => {
	await expect(
		bedrockClaudeRuntime({
			modelId: "anthropic.claude-opus-5-5",
			effort: "max",
			keyFile: await keyFile("sk-ant-wrong-provider"),
		}),
	).rejects.toThrow("Expected a Bedrock API key.");
});

it("estimates Opus 5.5 spend conservatively from cumulative usage", () => {
	expect(estimatedOpusCostUsd(null)).toBe(0);
	expect(
		estimatedOpusCostUsd({
			inputTokens: 1_100_000,
			outputTokens: 50_000,
			uncachedInputTokens: 100_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 0,
		}),
	).toBeCloseTo(0.4 + 0.4 + 1.0);
});
