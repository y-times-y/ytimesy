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
	/** The last whole-repo review; a day ago unless given. */
	lastReview?: Date | null;
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
		similarity: async () => null,
		lastReview: async () =>
			options.lastReview === undefined
				? new Date("2026-10-14T00:00:00Z")
				: options.lastReview,
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

	it("also reviews the whole repo once a week, with more steps, and records it", async () => {
		const files = {
			"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
			"tooling.md":
				"# tooling\n- Use npm for installs [added: 2026-02-03]\n- Install packages with pnpm [added: 2026-06-01]\n",
		};
		const script = async (tools: ModelAgentInput["tools"]) => {
			await call(tools, "commit", { message: "Nothing new" });
		};
		const { deps, calls, call } = harness({
			files,
			chats,
			lastReview: null,
			script,
		});
		expect(await runMemoryDream("u1", deps, 5)).toBe("unchanged");
		const prompt = String(calls.agent[0].messages[0].content);
		expect(prompt).toContain("Whole-repo review");
		expect(prompt).toContain(
			"### tooling.md\n1: # tooling\n2: - Use npm for installs",
		);
		expect(calls.agent[0].maxSteps).toBe(36);
		expect(calls.usage).toEqual([
			expect.objectContaining({ kind: "dream", outcome: "completed:review" }),
		]);

		for (const lastReview of [new Date("2026-10-12T00:00:00Z"), undefined]) {
			const recent = harness({
				files,
				chats,
				lastReview,
				script: async () => {},
			});
			await runMemoryDream("u1", recent.deps, 5);
			expect(String(recent.calls.agent[0].messages[0].content)).not.toContain(
				"Whole-repo review",
			);
			expect(recent.calls.agent[0].maxSteps).toBe(5);
		}
		const huge = harness({
			files: { ...files, "big.md": "- x\n".repeat(20_000) },
			chats,
			lastReview: null,
		});
		await runMemoryDream("u1", huge.deps, 5);
		expect(String(huge.calls.agent[0].messages[0].content)).not.toContain(
			"Whole-repo review",
		);
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
		expect(calls.usage).toEqual([
			expect.objectContaining({ kind: "save", outcome: "completed" }),
		]);
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
			expect.objectContaining({
				kind: "save",
				outcome: "completed:nothing-new",
			}),
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

	it("retires the line a new decision replaces, by the id it was shown", async () => {
		const tooling =
			"# tooling\n- Use npm for installs [source: a]\n- Node is pinned to 22 [source: b]\n";
		const { deps, calls, commits } = harness({
			files: {
				"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
				"tooling.md": tooling,
			},
			chats: [
				chat("11111111-1111-4111-8111-111111111111", [
					item({
						kind: "userMessage",
						id: "1",
						text: "We switched installs to pnpm; use it from now on",
					}),
				]),
			],
			answer:
				'{"entries":[{"file":"tooling.md","text":"Install packages with pnpm, not npm","project":"","replaces":"tooling.md:2"}]}',
		});
		expect(
			await runMemorySave("u1", "11111111-1111-4111-8111-111111111111", deps),
		).toBe("saved");
		// The prompt showed the related lines with their ids, not the index link.
		const prompt = String(calls.agent[0].messages[0].content);
		expect(prompt).toContain(
			"tooling.md:2: - Use npm for installs [source: a]",
		);
		expect(prompt).not.toContain("[[tooling]]");
		expect(calls.agent[0].instructions).toContain('"replaces"');
		const source =
			"https://ytimesy.test/?chat=11111111-1111-4111-8111-111111111111";
		expect(commits[0].changes).toEqual([
			{
				path: "tooling.md",
				content: `# tooling\n- Use npm for installs [source: a] [superseded-by: ${source}]\n- Node is pinned to 22 [source: b]\n- Install packages with pnpm, not npm [source: ${source}; added: 2026-10-15]\n`,
			},
		]);
	});

	it("ignores a replaced id it never showed, and keeps the user's brackets", () => {
		const files = { "tooling.md": "# tooling\n- Use npm [source: a]\n" };
		expect(
			saveHookChanges(
				files,
				[
					{
						file: "logging.md",
						text: "Log lines in orders.py start with [orders]",
						project: "",
					},
				],
				{ source: "s", today: "2026-10-15" },
			)[0],
		).toEqual({
			path: "logging.md",
			content:
				"# logging\n- Log lines in orders.py start with [orders] [source: s; added: 2026-10-15]\n",
		});
	});

	it("keeps an old line whose structured details the replacement would lose", () => {
		const api =
			'# api\n- API errors return {"error": {"code": "<snake_case_code>", "message": "<text>"}} [source: a]\n';
		const [change] = saveHookChanges(
			{ "api.md": api },
			[
				{
					file: "api.md",
					text: "API error codes are UPPER_SNAKE_CASE, e.g. ITEMS_REQUIRED",
					project: "",
					replaces: {
						path: "api.md",
						raw: '- API errors return {"error": {"code": "<snake_case_code>", "message": "<text>"}} [source: a]',
					},
				},
			],
			{
				source: "s",
				today: "2026-10-15",
				message:
					"Error codes must be UPPER_SNAKE_CASE from now on, like ITEMS_REQUIRED.",
			},
		);
		expect(change.content).not.toContain("superseded-by");
		expect(change.content).toContain("UPPER_SNAKE_CASE");
		// Restating the whole shape retires the old line as before.
		const [whole] = saveHookChanges(
			{ "api.md": api },
			[
				{
					file: "api.md",
					text: 'API errors return {"error": {"code": "<UPPER_SNAKE_CASE>", "message": "<text>"}}',
					project: "",
					scope: "always",
					replaces: {
						path: "api.md",
						raw: '- API errors return {"error": {"code": "<snake_case_code>", "message": "<text>"}} [source: a]',
					},
				},
			],
			{ source: "s", today: "2026-10-15", message: "codes in upper case" },
		);
		expect(whole.content).toContain("[superseded-by: s]");
		expect(whole.content).toContain(
			"[scope: always; source: s; added: 2026-10-15]",
		);
	});

	it("retries a failed model call once, but not a timeout", async () => {
		const failing = (name: string, failures: number) => {
			const setup = harness({
				files: { "MEMORY.md": "# Memory\n\n## Index\n" },
				chats,
				answer:
					'{"entries":[{"file":"tooling.md","text":"Uses pnpm, never npm","project":""}]}',
			});
			const run = setup.deps.runAgent;
			let calls = 0;
			const slept: number[] = [];
			setup.deps.runAgent = async (input, route) => {
				if (calls++ < failures)
					throw Object.assign(new Error("boom"), { name });
				return run(input, route);
			};
			setup.deps.sleep = async (ms) => {
				slept.push(ms);
			};
			return { ...setup, slept, attempts: () => calls };
		};
		const once = failing("AI_APICallError", 1);
		expect(
			await runMemorySave(
				"u1",
				"11111111-1111-4111-8111-111111111111",
				once.deps,
			),
		).toBe("saved");
		expect(once.attempts()).toBe(2);
		expect(once.slept).toEqual([2000]);
		expect(once.calls.usage).toEqual([
			expect.objectContaining({ outcome: "failed:AI_APICallError" }),
			expect.objectContaining({ outcome: "completed" }),
		]);
		const twice = failing("AI_APICallError", 2);
		expect(
			await runMemorySave(
				"u1",
				"11111111-1111-4111-8111-111111111111",
				twice.deps,
			),
		).toBe("failed:AI_APICallError");
		expect(twice.attempts()).toBe(2);
		const timeout = failing("TimeoutError", 1);
		expect(
			await runMemorySave(
				"u1",
				"11111111-1111-4111-8111-111111111111",
				timeout.deps,
			),
		).toBe("failed:TimeoutError");
		expect(timeout.attempts()).toBe(1);
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
