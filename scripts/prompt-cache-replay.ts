// Replays recorded builder turns through the real model loop and the Codex
// subscription adapter with a capturing fetch, one durable step at a time,
// and reports where each request's bytes stop matching the previous one.
// No network, database or VM is used.
//
//   node --import tsx scripts/prompt-cache-replay.ts --surface current <transcript.json>...
//
// A transcript is a smoke-suite record (scripts/smoke/builder-harness.ts)
// whose `messages` are the turn's saved model history (api_turn.messages).
// Step k's request is rebuilt from the history before the k-th model-written
// assistant message, so it is exactly what the loop sends for that history.
// The tools and system instructions are rebuilt for every step the way a new
// durable step rebuilds them (fresh tool objects, the step's call prefix).
//
// Token counts are estimates (characters / 4 of the serialized JSON, then
// scaled per turn to the recorded input-token total). The ideal cached share
// assumes every request's whole prefix is cached for the next one and OpenAI's
// 128-token cache granularity (nothing below 1024 tokens).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import type { HarnessToolSurfaceId } from "#/domain/harness-variant";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { nativeWebSearchTools } from "#/server/adapters/native-web-search";
import { agentTurnInstructions } from "#/server/services/agent-turn-instructions";
import { apiAgentTools } from "#/server/services/api-agent-tools";
import { builderToolSurface } from "#/server/services/builder-shell-surface";
import {
	type ModelAgentRuntime,
	runModelAgentStep,
} from "#/server/services/model-agent-loop";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

type Body = Record<string, unknown>;
type Transcript = {
	record: {
		inputTokens: number;
		cachedTokens: number;
		modelSteps: number;
		cacheHitPercent: number;
	};
	messages: ModelMessage[];
};

const surfaceFlag = process.argv.indexOf("--surface");
const surface = (
	surfaceFlag > 0 ? process.argv[surfaceFlag + 1] : "current"
) as HarnessToolSurfaceId;
const memoryFlag = process.argv.indexOf("--memory-instructions");
const memoryInstructions =
	memoryFlag > 0
		? await readFile(process.argv[memoryFlag + 1], "utf8")
		: undefined;
const files = process.argv
	.slice(2)
	.filter(
		(value, index, all) =>
			!value.startsWith("--") &&
			all[index - 1] !== "--surface" &&
			all[index - 1] !== "--dump" &&
			all[index - 1] !== "--memory-instructions",
	);
const verbose = process.argv.includes("--verbose");
const dumpFlag = process.argv.indexOf("--dump");
const dumpDirectory = dumpFlag > 0 ? process.argv[dumpFlag + 1] : undefined;

const session = {
	id: "00000000-0000-4000-8000-000000000001",
	userId: "fixture-owner",
	projectId: "00000000-0000-4000-8000-000000000002",
	workspaceId: "00000000-0000-4000-8000-000000000003",
	harness: "codex",
	providerRef: WorkspaceId("fixture-vm"),
	parentSessionId: null,
	title: "Fixture",
	taskAccess: null,
} as unknown as AgentSessionRecord;

/** Tools and instructions as a durable step of api-turn.ts assembles them. */
function stepRequest(stepIndex: number) {
	const machines = {
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readTextFile: async () => null,
		writeTextFile: async () => {},
	} as unknown as WorkspaceMachines;
	const signal = new AbortController().signal;
	const workspace = async () => ({
		machines,
		vm: WorkspaceId("fixture-vm"),
		cwd: "/home/ubuntu/ytimesy",
	});
	const built = builderToolSurface({
		variant: surface,
		modelId: "gpt-6.1-sol",
		tools: apiAgentTools({
			machines,
			session,
			workspace,
			turnId: "fixture-turn",
			signal,
			writable: true,
			freeformPatch: true,
			toolCallPrefix: `step-${stepIndex}:`,
		}),
		lean: {
			workspace,
			sessionId: session.id,
			turnId: "fixture-turn",
			toolCallPrefix: `step-${stepIndex}:`,
			signal,
			installHelpers: async () => {},
		},
	});
	const tools: ToolSet = {
		...built.tools,
		...nativeWebSearchTools("openai"),
	};
	const instructions = agentTurnInstructions({
		session,
		tools,
		plugins: [],
		projectKnowledge: null,
		leanShape: built.lean?.shape,
		leanWorkingDirectory: built.lean ? "/home/ubuntu/ytimesy" : undefined,
	});
	return {
		tools,
		instructions: memoryInstructions
			? `${instructions}\n${memoryInstructions}`
			: instructions,
	};
}

class Captured extends Error {}

async function capture(stepIndex: number, messages: ModelMessage[]) {
	let body: Body | undefined;
	let headers: Headers | undefined;
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		body = JSON.parse(String(init?.body));
		headers = new Headers(init?.headers);
		throw new Captured();
	};
	const request = stepRequest(stepIndex);
	const runtime: ModelAgentRuntime = {
		model: connectedLanguageModel(
			{
				provider: "openai",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				modelId: "gpt-6.1-sol",
				apiKey: "fixture",
			},
			fetch,
		),
		contextWindow: 500_000,
		requestSettings: (instructions) => ({
			providerOptions: {
				openai: {
					instructions,
					store: false,
					promptCacheKey: "fixture",
					reasoningEffort: "medium",
					reasoningSummary: "auto",
					parallelToolCalls: true,
				},
			},
		}),
	};
	await runModelAgentStep(
		{
			userId: "fixture-owner",
			modelId: "gpt-6.1-sol",
			toolSurface: "implementation",
			instructions: request.instructions,
			messages,
			tools: request.tools,
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
		},
		runtime,
	).catch((error) => {
		if (!body) throw (error as { cause?: unknown }).cause ?? error;
	});
	if (!body) throw new Error("No request was captured.");
	return { body, headers };
}

/** The serialized request as a prefix-ordered list: instructions, tools, then each input item. */
function segments(body: Body) {
	const head = { ...body };
	delete head.input;
	delete head.instructions;
	delete head.tools;
	return [
		["params", JSON.stringify(head)],
		["instructions", JSON.stringify(body.instructions ?? "")],
		["tools", JSON.stringify(body.tools ?? [])],
		...((body.input ?? []) as Body[]).map(
			(item, index) =>
				[
					`input[${index}] ${String(item.type ?? item.role)}`,
					JSON.stringify(item),
				] as const,
		),
	] as [string, string][];
}

function firstDifference(
	previous: [string, string][],
	current: [string, string][],
) {
	let shared = 0;
	for (let index = 0; index < current.length; index++) {
		const [name, text] = current[index];
		const before = previous[index];
		if (before && before[0] === name && before[1] === text) {
			shared += text.length;
			continue;
		}
		if (index >= previous.length) return { shared, at: null };
		let offset = 0;
		const old = before?.[1] ?? "";
		while (offset < text.length && text[offset] === old[offset]) offset++;
		return {
			shared: shared + offset,
			at: {
				segment: name,
				previousSegment: before?.[0],
				offset,
				was: old.slice(Math.max(0, offset - 40), offset + 80),
				now: text.slice(Math.max(0, offset - 40), offset + 80),
			},
		};
	}
	return { shared, at: null };
}

const isPrefetch = (message: ModelMessage) =>
	message.role === "assistant" &&
	Array.isArray(message.content) &&
	message.content.every(
		(part) =>
			part.type === "tool-call" && part.toolCallId.startsWith("call_prefetch_"),
	);

const totals = {
	input: 0,
	cached: 0,
	ideal: 0,
	breaks: new Map<string, number>(),
};
for (const file of files) {
	const transcript = JSON.parse(await readFile(file, "utf8")) as Transcript;
	const messages = transcript.messages;
	const starts = messages.flatMap((message, index) =>
		message.role === "assistant" && !isPrefetch(message) ? [index] : [],
	);
	// The params block holds model settings only; it is not part of the cached
	// prompt prefix (instructions, tools, input are).
	let previous: [string, string][] | undefined;
	const steps: {
		characters: number;
		sharedCharacters: number;
		at: ReturnType<typeof firstDifference>["at"];
	}[] = [];
	for (const [position, start] of starts.entries()) {
		const { body } = await capture(position + 1, messages.slice(0, start));
		if (dumpDirectory) {
			await mkdir(dumpDirectory, { recursive: true });
			await writeFile(
				join(
					dumpDirectory,
					`${basename(file, ".json")}.step-${position + 1}.json`,
				),
				JSON.stringify(body),
			);
		}
		const current = segments(body).slice(1);
		const characters = current.reduce((sum, [, text]) => sum + text.length, 0);
		const diff = previous
			? firstDifference(previous, current)
			: { shared: 0, at: null };
		if (diff.at)
			totals.breaks.set(
				diff.at.segment,
				(totals.breaks.get(diff.at.segment) ?? 0) + 1,
			);
		steps.push({ characters, sharedCharacters: diff.shared, at: diff.at });
		previous = current;
	}
	const estimated = steps.reduce((sum, step) => sum + step.characters, 0);
	const scale = transcript.record.inputTokens / estimated;
	const ideal = steps.reduce((sum, step, index) => {
		if (index === 0) return sum;
		const tokens = step.sharedCharacters * scale;
		return sum + (tokens < 1024 ? 0 : Math.floor(tokens / 128) * 128);
	}, 0);
	totals.input += transcript.record.inputTokens;
	totals.cached += transcript.record.cachedTokens;
	totals.ideal += ideal;
	console.log(
		`${file.split("/").slice(-2).join("/")}: steps=${steps.length} input=${transcript.record.inputTokens} cached=${transcript.record.cachedTokens} (${transcript.record.cacheHitPercent}%) idealCached=${ideal} (${((100 * ideal) / transcript.record.inputTokens).toFixed(1)}%) firstStep≈${Math.round(steps[0].characters * scale)} tokens/char=${scale.toFixed(3)}`,
	);
	for (const [index, step] of steps.entries())
		if (step.at || verbose)
			console.log(
				`  step ${index + 1}: ≈${Math.round(step.characters * scale)} tok, shared ≈${Math.round(step.sharedCharacters * scale)}${step.at ? ` BREAK in ${step.at.segment} @${step.at.offset}\n    was: ${JSON.stringify(step.at.was)}\n    now: ${JSON.stringify(step.at.now)}` : ""}`,
			);
}
console.log(
	`TOTAL input=${totals.input} cached=${totals.cached} (${((100 * totals.cached) / totals.input).toFixed(1)}%) idealCached=${totals.ideal} (${((100 * totals.ideal) / totals.input).toFixed(1)}%) breaks=${JSON.stringify(Object.fromEntries(totals.breaks))}`,
);
