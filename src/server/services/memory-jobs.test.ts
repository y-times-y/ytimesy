import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { MemoryRepo } from "../adapters/memory-repos";
import type { MemoryChat } from "../adapters/memory-settings";
import type { ModelAgentInput } from "./model-agent-loop";

vi.mock("./api-agent-runtime", () => ({ runApiAgent: vi.fn() }));
vi.mock("./codex-subscription-agent", () => ({
	runCodexSubscriptionAgent: vi.fn(),
}));
const { dreamChat, runMemoryDream, runMemorySave, saveHookChanges } =
	await import("./memory-jobs");
type Deps = NonNullable<Parameters<typeof runMemoryDream>[1]>;

const SINCE = new Date("2026-10-14T00:00:00Z");
const item = (value: object) => value as unknown as SessionItem;
const chat = (
	id: string,
	items: SessionItem[],
	updatedAt = "2026-10-15T10:00:00Z",
): MemoryChat => ({
	id,
	title: `Chat ${id}`,
	project: "acme/web",
	updatedAt: new Date(updatedAt),
	items,
});
const apiRoute = {
	connectionId: "c1",
	connectionRevision: "rev-1",
	modelId: "model-x",
	settings: {},
};
const subscriptionRoute = {
	connectionId: null,
	connectionRevision: subscriptionTurnRevision(),
	modelId: "gpt-x",
	settings: {},
};

function harness(options: {
	files?: Record<string, string>;
	chats?: MemoryChat[];
	route?: typeof apiRoute | typeof subscriptionRoute | null;
	mode?: "off" | "spec" | "full";
	/** Each model step: tool calls to run, in order. */
	script?: (tools: ModelAgentInput["tools"], step: number) => Promise<void>;
	steps?: number;
	answer?: string;
}) {
	const commits: { changes: unknown; message: string }[] = [];
	const repo: MemoryRepo = {
		name: "memory-u1",
		snapshot: async () => ({ head: "h1", files: { ...(options.files ?? {}) } }),
		snapshotAt: async () => ({ head: "h1", files: {} }),
		commit: async (_base, changes, message) => {
			commits.push({ changes, message });
			return { ok: true, hash: "h2" };
		},
		credentials: async () => ({ remote: "r", token: "t" }),
		history: async () => [],
		destroy: async () => {},
	};
	const calls = {
		reserve: [] as number[],
		usage: [] as unknown[],
		dreamed: [] as Date[],
		agent: [] as ModelAgentInput[],
		routes: [] as unknown[],
		saved: [] as unknown[][],
		warmed: [] as string[][],
	};
	const deps: Deps = {
		settings: async () => ({
			mode: options.mode ?? "full",
			repo: null,
			dreamedThrough: SINCE,
		}),
		repo: () => repo,
		chatsSince: async () => options.chats ?? [],
		chat: async (_user, id) =>
			options.chats?.find((row) => row.id === id) ?? null,
		route: async () => (options.route === undefined ? apiRoute : options.route),
		runAgent: async (input, route) => {
			calls.agent.push(input);
			calls.routes.push(route);
			const steps = options.steps ?? 1;
			for (let step = 0; step < steps; step++) {
				const history: ModelMessage[] = input.messages;
				await input.beforeStep?.(history);
				await options.script?.(input.tools, step);
				await input.onEvent({
					type: "usage",
					usage: {
						inputTokens: 1000 * (step + 1),
						outputTokens: 100 * (step + 1),
						uncachedInputTokens: null,
						cacheReadTokens: 0,
						cacheWriteTokens: null,
					},
				} as ApiAgentEvent);
			}
			if (options.answer)
				await input.onEvent({
					type: "text-delta",
					id: "t",
					text: options.answer,
				} as ApiAgentEvent);
			if (
				steps >= (input.maxSteps ?? 0) &&
				!options.answer &&
				!committed(input)
			)
				throw Object.assign(new Error("stopped"), {
					name: "IncompleteAgentTurn",
				});
			return [];
		},
		reserve: async (_user, tokens) => {
			calls.reserve.push(tokens);
		},
		recordUsage: async (row) => {
			calls.usage.push(row);
		},
		markDreamed: async (_user, through) => {
			calls.dreamed.push(through);
		},
		recordSaved: async (...args) => {
			calls.saved.push(args);
			return true;
		},
		warmLines: async (_user, texts) => {
			calls.warmed.push([...texts]);
		},
		appUrl: "https://ytimesy.test",
		today: () => "2026-10-15",
	};
	let commitCalled = false;
	const committed = (_input: ModelAgentInput) => commitCalled;
	const call = async (
		tools: ModelAgentInput["tools"],
		name: string,
		args: object,
	) => {
		if (name === "commit") commitCalled = true;
		return tools[name].execute?.(args as never, {
			toolCallId: name,
			messages: [],
			context: {},
		});
	};
	return { deps, calls, commits, call };
}

describe("dream inbox", () => {
	it("reads only turns after the last dream, with replies and failed commands", () => {
		const read = dreamChat(
			chat("c1", [
				item({
					kind: "userMessage",
					id: "1",
					text: "old request",
					timing: { startedAt: SINCE.getTime() - 1 },
				}),
				item({ kind: "agentMessage", id: "2", text: "old reply" }),
				item({
					kind: "userMessage",
					id: "3",
					text: "Use pnpm here",
					timing: { startedAt: SINCE.getTime() + 1 },
				}),
				item({
					kind: "commandExecution",
					id: "4",
					command: "npm i",
					exitCode: 1,
					output: "lockfile mismatch",
					status: "failed",
					cwd: null,
				}),
				item({
					kind: "agentMessage",
					id: "5",
					text: "thinking",
					phase: "commentary",
				}),
				item({
					kind: "agentMessage",
					id: "6",
					text: "Switched to pnpm.",
					phase: "final_answer",
				}),
			]),
			SINCE,
			"https://ytimesy.test",
			true,
		);
		expect(read).toMatchObject({
			url: "https://ytimesy.test/?chat=c1",
			userMessages: ["Use pnpm here"],
			agentReplies: ["Switched to pnpm."],
			failedCommands: [{ command: "npm i", output: "lockfile mismatch" }],
		});
	});

	it("does nothing, and spends nothing, when there are no new chats", async () => {
		const { deps, calls } = harness({ chats: [] });
		expect(await runMemoryDream("u1", deps)).toBe("idle");
		expect(calls.agent).toEqual([]);
		expect(calls.dreamed).toEqual([]);
	});

	it("skips dreaming when the user has no usable model route", async () => {
		const { deps, calls } = harness({
			chats: [
				chat("c1", [item({ kind: "userMessage", id: "1", text: "Use pnpm" })]),
			],
			route: null,
		});
		expect(await runMemoryDream("u1", deps)).toBe("no-route");
		expect(calls.agent).toEqual([]);
		expect(calls.dreamed).toEqual([]);
	});
});

describe("dreaming", () => {
	const chats = [
		chat(
			"c2",
			[
				item({
					kind: "userMessage",
					id: "1",
					text: "Always store timestamps in UTC",
				}),
			],
			"2026-10-15T11:00:00Z",
		),
		chat("c1", [
			item({ kind: "userMessage", id: "1", text: "Use pnpm, never npm" }),
		]),
	];

	it("makes one commit, on the user's API route, reserving their budget before every step", async () => {
		const { deps, calls, commits, call } = harness({
			files: {
				"MEMORY.md": "# Memory\n\n## Index\n",
				"old.md": "- Freeze deploys [expires: 2026-01-01]\n",
			},
			chats,
			steps: 2,
			script: async (tools, step) => {
				if (step === 0)
					await call(tools, "write_file", {
						path: "tooling.md",
						content:
							"- Uses pnpm [source: https://ytimesy.test/?chat=c1; added: 2026-10-15]",
					});
				else await call(tools, "commit", { message: "Add tooling" });
			},
		});
		expect(await runMemoryDream("u1", deps, 5)).toBe("committed");
		expect(calls.agent[0].maxSteps).toBe(5);
		expect(calls.agent[0].endTurnTools).toEqual(["commit"]);
		expect(calls.agent[0].messages[0].content).toContain(
			"Always store timestamps in UTC",
		);
		expect(calls.routes).toEqual([{ subscription: false, connectionId: "c1" }]);
		expect(calls.reserve).toHaveLength(2);
		expect(calls.usage).toEqual([
			expect.objectContaining({
				kind: "dream",
				modelId: "model-x",
				steps: 2,
				outcome: "completed",
				usage: expect.objectContaining({
					inputTokens: 2000,
					outputTokens: 200,
				}),
			}),
		]);
		expect(commits).toHaveLength(1);
		expect(commits[0].message).toBe("Dream: Add tooling");
		expect(commits[0].changes).toEqual(
			expect.arrayContaining([
				{ path: "tooling.md", content: expect.stringContaining("Uses pnpm") },
				// Expired entries are removed in full mode.
				{ path: "old.md", content: "" },
			]),
		);
		expect(calls.dreamed).toEqual([new Date("2026-10-15T11:00:00Z")]);
	});

	it("uses the ChatGPT plan without an API reservation", async () => {
		const { deps, calls, call } = harness({
			chats,
			route: subscriptionRoute,
			script: (tools) =>
				call(tools, "commit", { message: "nothing new" }).then(() => {}),
		});
		expect(await runMemoryDream("u1", deps)).toBe("unchanged");
		expect(calls.routes).toEqual([{ subscription: true, connectionId: null }]);
		expect(calls.reserve).toEqual([]);
		expect(calls.usage).toHaveLength(1);
	});

	it("stops at the step cap without committing, and does not bill the same inbox again", async () => {
		const { deps, calls, commits, call } = harness({
			chats,
			steps: 3,
			script: (tools) =>
				call(tools, "write_file", { path: "x.md", content: "- partial" }).then(
					() => {},
				),
		});
		expect(await runMemoryDream("u1", deps, 3)).toBe("incomplete");
		expect(commits).toEqual([]);
		expect(calls.usage).toEqual([
			expect.objectContaining({ outcome: "step-limit", steps: 3 }),
		]);
		expect(calls.dreamed).toHaveLength(1);
	});
});

describe("save hook", () => {
	const chats = [
		chat("11111111-1111-4111-8111-111111111111", [
			item({
				kind: "userMessage",
				id: "1",
				text: "From now on always use pnpm, never npm",
			}),
		]),
	];

	it("saves what the agent missed, citing the chat, billed to the user", async () => {
		const { deps, calls, commits } = harness({
			files: { "MEMORY.md": "# Memory\n\n## Index\n" },
			chats,
			answer:
				'{"entries":[{"file":"tooling.md","text":"Uses pnpm, never npm","project":"acme/web"}]}',
		});
		expect(
			await runMemorySave("u1", "11111111-1111-4111-8111-111111111111", deps),
		).toBe("saved");
		expect(calls.agent[0].maxSteps).toBe(1);
		expect(calls.reserve).toHaveLength(1);
		expect(calls.usage).toEqual([expect.objectContaining({ kind: "save" })]);
		expect(commits[0].changes).toEqual([
			{
				path: "tooling.md",
				content:
					"# tooling\n- Uses pnpm, never npm [project: acme/web; source: https://ytimesy.test/?chat=11111111-1111-4111-8111-111111111111; added: 2026-10-15]\n",
			},
			{ path: "MEMORY.md", content: "# Memory\n\n## Index\n- [[tooling]]\n" },
		]);
		// The chat shows the saved line under the turn whose message it came from.
		expect(calls.saved).toEqual([
			[
				"u1",
				"11111111-1111-4111-8111-111111111111",
				"1",
				[{ path: "tooling.md", text: "Uses pnpm, never npm" }],
			],
		]);
		// The new line is embedded before the next chat's read hook needs it.
		expect(calls.warmed).toEqual([["tooling: Uses pnpm, never npm"]]);
	});

	it("runs after every turn in full mode, and never outside it", async () => {
		const plain = harness({
			chats: [
				chat("c9", [
					item({ kind: "userMessage", id: "1", text: "Fix the failing test" }),
				]),
			],
			answer: '{"entries":[]}',
		});
		expect(await runMemorySave("u1", "c9", plain.deps)).toBe("nothing-new");
		expect(plain.calls.saved).toEqual([]);
		expect(plain.calls.agent).toHaveLength(1);
		expect(plain.calls.usage).toEqual([
			expect.objectContaining({ kind: "save" }),
		]);
		const spec = harness({ chats, mode: "spec" });
		expect(
			await runMemorySave(
				"u1",
				"11111111-1111-4111-8111-111111111111",
				spec.deps,
			),
		).toBe("off");
		expect(spec.calls.agent).toEqual([]);
	});

	it("never duplicates an entry already in memory", () => {
		expect(
			saveHookChanges(
				{ "tooling.md": "- Uses pnpm, never npm [source: x]\n" },
				[{ file: "tooling.md", text: "Uses pnpm, never npm", project: "" }],
				{ source: "s", today: "2026-10-15" },
			),
		).toEqual([]);
	});
});
