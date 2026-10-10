import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { afterEach, expect, it } from "vitest";
import {
	estimatedSolCostUsd,
	OPENAI_API_BASE_URL,
	openAiSolRuntime,
} from "../benchmarks/evaluation/openai-sol";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function keyFile(contents: string) {
	directory = await mkdtemp(join(tmpdir(), "openai-key-"));
	const path = join(directory, "key");
	await writeFile(path, contents);
	return path;
}

it("calls GPT-6.1 Sol through the Responses API at max effort with stable cache affinity", async () => {
	const bodies: Record<string, unknown>[] = [];
	const urls: string[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		urls.push(String(url));
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({
			id: "resp_fixture",
			created_at: 1,
			model: "gpt-6.1-sol",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg",
					role: "assistant",
					content: [{ type: "output_text", text: "OK", annotations: [] }],
				},
			],
			usage: { input_tokens: 3, output_tokens: 1 },
		});
	};
	const runtime = await openAiSolRuntime({
		modelId: "gpt-6.1-sol",
		effort: "max",
		cacheScope: "session-a",
		keyFile: await keyFile("sk-proj-fixture\n"),
		fetch,
	});
	for (let index = 0; index < 2; index++)
		await generateText({
			model: runtime.model,
			...runtime.requestSettings?.("Stable instructions"),
			prompt: "Say OK",
		});
	expect(urls[0]).toBe(`${OPENAI_API_BASE_URL}/responses`);
	expect(bodies[0]).toMatchObject({
		model: "gpt-6.1-sol",
		instructions: "Stable instructions",
		store: false,
		include: ["reasoning.encrypted_content"],
		reasoning: { effort: "max" },
		parallel_tool_calls: true,
	});
	expect(bodies[0]).not.toHaveProperty("service_tier");
	expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
	expect(runtime.compact).toBeDefined();
});

it("estimates GPT-6.1 Sol spend from cumulative usage", () => {
	expect(
		estimatedSolCostUsd({
			inputTokens: 1_100_000,
			outputTokens: 100_000,
			uncachedInputTokens: 100_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 0,
		}),
	).toBeCloseTo(0.25 + 0.25 + 1.0);
});
