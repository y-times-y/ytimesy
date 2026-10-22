import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ModelMessage,
	simulateReadableStream,
	type ToolSet,
	tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import { automaticRepositoryContext } from "./automatic-repository-context";
import { runModelAgent } from "./model-agent-loop";

async function fixtureRepository() {
	const fixture = await localHarnessWorkspace();
	const write = async (path: string, content: string) => {
		await mkdir(join(fixture.root, path, ".."), { recursive: true });
		await writeFile(join(fixture.root, path), content);
	};
	await write(
		"AGENTS.md",
		"Root rule: run pnpm test. See [guide](docs/guide.md).",
	);
	await write("docs/guide.md", "Guide body: prefer small modules.");
	await write("packages/api/AGENTS.md", "API rule: never touch migrations.");
	await write(
		".agents/skills/release/SKILL.md",
		"---\nname: release\ndescription: Cut a release build.\n---\nSecret skill body.",
	);
	await write("package.json", '{ "name": "fixture" }');
	return { ...fixture, write };
}

function builderContext(
	workspace: Awaited<ReturnType<typeof fixtureRepository>>["workspace"],
	turnStart = true,
	tools: ToolSet = {},
) {
	return automaticRepositoryContext({
		tools,
		workspace: async () => workspace,
		signal: new AbortController().signal,
		onEvent: async () => {},
		instructionMessages: { turnStart },
	});
}

const text = (message: ModelMessage | undefined) =>
	typeof message?.content === "string" ? message.content : "";

it("puts the repository instructions ahead of a fresh task, once per turn", async () => {
	const fixture = await fixtureRepository();
	try {
		const task: ModelMessage = { role: "user", content: "Fix the API" };
		const context = builderContext(fixture.workspace);
		const history = await context.prepare([task]);
		expect(history).toHaveLength(2);
		expect(history[1]).toBe(task);
		const injected = text(history[0]);
		expect(injected).toMatch(/^# Repository instructions\n/);
		expect(injected).toContain(
			"## AGENTS.md (applies to the whole repository)",
		);
		expect(injected).toContain("Root rule: run pnpm test.");
		expect(injected).toContain("- packages/api/AGENTS.md");
		expect(injected).not.toContain("API rule");
		expect(injected).toContain(
			"- release: Cut a release build. (.agents/skills/release/SKILL.md)",
		);
		expect(injected).not.toContain("Secret skill body");
		expect(injected).toContain("Guide body: prefer small modules.");
		expect(injected).toContain('{ "name": "fixture" }');
		expect(injected).not.toContain("read_repository_guidance");
		// Later steps of the same turn do not rescan or re-send.
		expect(await context.prepare(history)).toBe(history);
		// A non-initial durable step leaves history alone.
		expect(
			await builderContext(fixture.workspace, false).prepare([task]),
		).toEqual([task]);
	} finally {
		await fixture.cleanup();
	}
});

it("lists long linked documents and secondary configuration instead of inlining them", async () => {
	const fixture = await fixtureRepository();
	try {
		await fixture.write(
			"AGENTS.md",
			"Root rule. Before architectural changes read [the plan](PLAN.md); see [guide](docs/guide.md).",
		);
		await fixture.write(
			"PLAN.md",
			`# Plan\n${"Long plan detail. ".repeat(3000)}`,
		);
		await fixture.write(
			"tsconfig.json",
			'{ "compilerOptions": { "strict": true } }',
		);
		const [message] = await builderContext(fixture.workspace).prepare([
			{ role: "user", content: "Fix the API" },
		]);
		const injected = text(message);
		expect(injected).toContain("Guide body: prefer small modules.");
		expect(injected).not.toContain("Long plan detail.");
		expect(injected).toContain(
			"- PLAN.md (linked from AGENTS.md; about 54k characters)",
		);
		expect(injected).toContain('{ "name": "fixture" }');
		expect(injected).not.toContain('"strict": true');
		expect(injected).toContain(
			"Also at the repository root: tsconfig.json. Read them with cat when relevant.",
		);
	} finally {
		await fixture.cleanup();
	}
});

it("re-sends only changed instructions on a later turn and never rewrites history", async () => {
	const fixture = await fixtureRepository();
	try {
		const first = await builderContext(fixture.workspace).prepare([
			{ role: "user", content: "Fix the API" },
		]);
		const turnTwo: ModelMessage[] = [
			...first,
			{ role: "assistant", content: "Fixed." },
			{ role: "user", content: "Now the docs" },
		];
		expect(await builderContext(fixture.workspace).prepare(turnTwo)).toEqual(
			turnTwo,
		);
		// The builder's own config edits are not re-announced.
		await fixture.write("package.json", '{ "name": "renamed" }');
		expect(await builderContext(fixture.workspace).prepare(turnTwo)).toEqual(
			turnTwo,
		);
		await fixture.write("AGENTS.md", "Root rule: run pnpm check.");
		await fixture.write("web/CLAUDE.md", "Web rule.");
		const turnThree = await builderContext(fixture.workspace).prepare(turnTwo);
		expect(turnThree.slice(0, turnTwo.length)).toEqual(turnTwo);
		expect(turnThree).toHaveLength(turnTwo.length + 1);
		const update = text(turnThree.at(-1));
		expect(update).toMatch(/^# Repository instructions changed\n/);
		expect(update).toContain("Root rule: run pnpm check.");
		expect(update).toContain("- web/CLAUDE.md");
		expect(update).not.toContain('"renamed"');
		expect(update).not.toContain("Guide body");
		expect(await builderContext(fixture.workspace).prepare(turnThree)).toEqual(
			turnThree,
		);
	} finally {
		await fixture.cleanup();
	}
});

it("restores the instructions after compaction drops them", async () => {
	const fixture = await fixtureRepository();
	try {
		const context = builderContext(fixture.workspace);
		const compacted: ModelMessage[] = [
			{ role: "user", content: "Summary of earlier work" },
			{ role: "user", content: "Fix the API" },
		];
		const restored = await context.restoreInstructions(compacted);
		expect(restored.slice(0, 2)).toEqual(compacted);
		const message = text(restored[2]);
		expect(message).toMatch(
			/^# Repository instructions \(restored after context compaction\)/,
		);
		expect(message).toContain("Root rule: run pnpm test.");
		expect(message).toContain("- packages/api/AGENTS.md");
		expect(message).toContain('{ "name": "fixture" }');
		// Nothing is duplicated when the instructions survived compaction.
		expect(await context.restoreInstructions(restored)).toEqual(restored);
	} finally {
		await fixture.cleanup();
	}
});

it("includes instructions between the Git root and a subdirectory checkout", async () => {
	const fixture = await fixtureRepository();
	try {
		await fixture.write("packages/api/src/index.ts", "export {};");
		const history = await builderContext({
			...fixture.workspace,
			cwd: join(fixture.root, "packages/api"),
		}).prepare([{ role: "user", content: "Fix the API" }]);
		const injected = text(history[0]);
		expect(injected).toContain("## ../../AGENTS.md (from a parent folder");
		expect(injected).toContain("Root rule: run pnpm test.");
		expect(injected).toContain(
			"## AGENTS.md (applies to the whole repository)",
		);
		expect(injected).toContain("API rule: never touch migrations.");
	} finally {
		await fixture.cleanup();
	}
});

function answeringModel(provider: string) {
	return new MockLanguageModelV4({
		provider,
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{ type: "text-start", id: "answer" },
					{ type: "text-delta", id: "answer", delta: "Done" },
					{ type: "text-end", id: "answer" },
					{
						type: "finish",
						finishReason: { unified: "stop", raw: "stop" },
						usage: {
							inputTokens: {
								total: 1,
								noCache: 1,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 1, text: 1, reasoning: 0 },
						},
					},
				],
			}),
		}),
	});
}

it.each([
	["Codex subscription", "openai.responses", true],
	["API key", "anthropic.messages", false],
])(
	"delivers instructions before the first %s inference with a stable system prompt",
	async (_name, provider, prefetchInitialReads) => {
		const fixture = await fixtureRepository();
		try {
			const environment = vi.fn().mockResolvedValue({ available: false });
			const tools = {
				execute_command: tool({
					inputSchema: z.object({ command: z.string() }),
					execute: async () => ({ exitCode: 0 }),
				}),
				read_environment_report: tool({
					inputSchema: z.object({}),
					execute: environment,
				}),
			};
			const model = answeringModel(provider);
			const turn = async (messages: ModelMessage[]) => {
				const context = builderContext(fixture.workspace, true, tools);
				return runModelAgent(
					{
						userId: "alice",
						modelId: "fixture",
						messages,
						instructions: "Builder instructions",
						tools: context.tools,
						toolSurface: "implementation",
						signal: new AbortController().signal,
						onEvent: async () => {},
						onStep: async () => {},
						prepareMessages: context.prepare,
						restoreInstructions: context.restoreInstructions,
						afterTools: context.afterTools,
					},
					{ model, contextWindow: 128000, prefetchInitialReads },
				);
			};
			const first = await turn([{ role: "user", content: "Fix the API" }]);
			const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
			expect(prompt).toContain("Root rule: run pnpm test.");
			expect(prompt).toContain("packages/api/AGENTS.md");
			expect(prompt).not.toContain("read_repository_guidance");
			expect(
				model.doStreamCalls[0].tools?.map((entry) => entry.name),
			).not.toContain("read_repository_guidance");
			expect(environment).toHaveBeenCalledTimes(prefetchInitialReads ? 1 : 0);
			await turn([...first, { role: "user", content: "And the docs" }]);
			const [turnOne, turnTwo] = model.doStreamCalls.map((call) => call.prompt);
			expect(turnTwo[0]).toEqual(turnOne[0]);
			expect(turnTwo.slice(0, turnOne.length)).toEqual(turnOne);
			expect(
				JSON.stringify(turnTwo).split("# Repository instructions").length,
			).toBe(2);
		} finally {
			await fixture.cleanup();
		}
	},
);

it("a first request sent before its workspace was ready gets the instructions at the next step", async () => {
	const fixture = await fixtureRepository();
	try {
		const task: ModelMessage = { role: "user", content: "Fix the API" };
		const workspace = vi.fn(async () => fixture.workspace);
		let early = true;
		const first = automaticRepositoryContext({
			tools: {},
			workspace,
			signal: new AbortController().signal,
			onEvent: async () => {},
			// Read when the step is prepared, after the turn decided.
			instructionMessages: { turnStart: () => !early },
		});
		early = true;
		const sent = await first.prepare([task]);
		expect(sent).toEqual([task]);
		expect(workspace).not.toHaveBeenCalled();
		const afterTools: ModelMessage[] = [
			...sent,
			{
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "bash",
						output: { type: "text", value: "ok" },
					},
				],
			},
		];
		// The next step owes them: appended after the step's results, never
		// rewriting the history the first request sent.
		const next = await builderContext(fixture.workspace, true).prepare(
			afterTools,
		);
		expect(next.slice(0, afterTools.length)).toEqual(afterTools);
		expect(text(next.at(-1))).toMatch(/^# Repository instructions\n/);
	} finally {
		await fixture.cleanup();
	}
});
