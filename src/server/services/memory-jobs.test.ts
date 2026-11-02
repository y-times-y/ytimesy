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
const {
	dreamChat,
	runMemoryDream,
	runMemorySave,
	saveHookChanges,
	withoutNearDuplicates,
} = await import("./memory-jobs");
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
	projectRef: { fullName: "acme/web", name: "Web", repositoryIds: [7] },
	updatedAt: new Date(updatedAt),
	items,
});
/** The chat's project folder in the per-project layout. */
const WEB = "projects/acme-web--7";
/** A repo already in the per-project layout: no migration commit first. */
const LAYOUT = { ".memory-layout": "2\n" };
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
	/** Files as given, without the layout marker (a repo from before the layout). */
	legacy?: boolean;
	/** Each new entry's closest existing line, as embeddings would find it. */
	closest?: Deps["closestLines"];
}) {
	const commits: { changes: unknown; message: string }[] = [];
	const repo: MemoryRepo = {
		name: "memory-u1",
		snapshot: async () => ({
			head: "h1",
			files: { ...(options.legacy ? {} : LAYOUT), ...(options.files ?? {}) },
		}),
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
		closestLines: options.closest ?? (async () => null),
		projects: async () => [
			{ fullName: "acme/web", name: "Web", repositoryIds: [7] },
		],
		recalls: async () => ({ recalled: new Map(), since: null }),
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
				"personal/old.md": "- Freeze deploys [expires: 2026-01-01]\n",
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
				{ path: "personal/old.md", content: "" },
			]),
		);
		expect(calls.dreamed).toEqual([new Date("2026-10-15T11:00:00Z")]);
		// The dream is told the layout, each chat's project and the project folders.
		const prompt = String(calls.agent[0].messages[0].content);
		expect(prompt).toContain("· project acme/web ·");
		expect(prompt).toContain(`Project folders:\n- ${WEB}/ = acme/web`);
		expect(calls.agent[0].instructions).toContain("personal/<topic>.md");
	});

	it("also reviews the whole repo once a week, with more steps, and records it", async () => {
		const files = {
			"MEMORY.md": "# Memory\n\n## Index\n- [[personal/tooling]]\n",
			"personal/tooling.md":
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
		expect(prompt).toContain(
			"Review: this dream also does the periodic pass over personal/",
		);
		expect(prompt).toContain(
			"### personal/tooling.md\n1: # tooling\n2: - Use npm for installs",
		);
		expect(prompt).toContain("Sort personal/");
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
				"Review: this dream",
			);
			expect(recent.calls.agent[0].maxSteps).toBe(5);
		}
		// A memory past the budget is still reviewed: the folders (and files) that fit.
		const huge = harness({
			files: {
				...files,
				"personal/big.md": "- x\n".repeat(20_000),
				[`${WEB}/api.md`]: "# api\n- Errors are JSON [added: 2026-10-01]\n",
			},
			chats,
			lastReview: null,
		});
		await runMemoryDream("u1", huge.deps, 5);
		const big = String(huge.calls.agent[0].messages[0].content);
		expect(big).toContain(
			`periodic pass over personal/ (in part), ${WEB}/ (next time: personal/)`,
		);
		expect(big).toContain("### personal/tooling.md");
		expect(big).toContain(`### ${WEB}/api.md`);
		expect(big).not.toContain("### personal/big.md");
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
				'{"entries":[{"file":"tooling.md","text":"Uses pnpm, never npm","personal":""}]}',
		});
		expect(
			await runMemorySave("u1", "11111111-1111-4111-8111-111111111111", deps),
		).toBe("saved");
		expect(calls.agent[0].maxSteps).toBe(1);
		expect(calls.reserve).toHaveLength(1);
		expect(calls.usage).toEqual([
			expect.objectContaining({ kind: "save", outcome: "completed" }),
		]);
		// The chat's project folder by default; the folder says where it applies.
		expect(commits[0].changes).toEqual([
			{
				path: `${WEB}/tooling.md`,
				content:
					"# tooling\n- Uses pnpm, never npm [source: https://ytimesy.test/?chat=11111111-1111-4111-8111-111111111111; added: 2026-10-15]\n",
			},
			{
				path: "MEMORY.md",
				content: `# Memory\n\n## Index\n- [[${WEB}/tooling]]\n`,
			},
		]);
		// The chat shows the saved line under the turn whose message it came from.
		expect(calls.saved).toEqual([
			[
				"u1",
				"11111111-1111-4111-8111-111111111111",
				"1",
				[{ path: `${WEB}/tooling.md`, text: "Uses pnpm, never npm" }],
			],
		]);
		// The new line is embedded before the next chat's read hook needs it.
		expect(calls.warmed).toEqual([["tooling: Uses pnpm, never npm"]]);
	});

	it("runs after every turn in full mode, and never outside it", async () => {
		const plain = harness({
			chats: [
				chat("c9", [
					item({
						kind: "userMessage",
						id: "1",
						text: "We should keep the retry count at 3",
					}),
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
				"MEMORY.md": `# Memory\n\n## Index\n- [[${WEB}/tooling]]\n`,
				[`${WEB}/tooling.md`]: tooling,
				// Another project's line is never shown, so never replaced.
				"projects/acme-api--8/tooling.md":
					"# tooling\n- Use yarn [source: c]\n",
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
			answer: `{"entries":[{"file":"tooling.md","text":"Install packages with pnpm, not npm","replaces":"${WEB}/tooling.md:2"}]}`,
		});
		expect(
			await runMemorySave("u1", "11111111-1111-4111-8111-111111111111", deps),
		).toBe("saved");
		// The prompt showed the memory lines with their ids (without their
		// source links), not the index link.
		const prompt = String(calls.agent[0].messages[0].content);
		expect(prompt).toContain(`${WEB}/tooling.md:2: - Use npm for installs\n`);
		expect(prompt).not.toContain("[source: a]");
		expect(prompt).not.toContain("[[");
		expect(prompt).not.toContain("Use yarn");
		expect(calls.agent[0].instructions).toContain('"replaces"');
		const source =
			"https://ytimesy.test/?chat=11111111-1111-4111-8111-111111111111";
		expect(commits[0].changes).toEqual([
			{
				path: `${WEB}/tooling.md`,
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

	it("orders its prompt for the prompt cache and records the run once it is done", async () => {
		const files = {
			"MEMORY.md": `# Memory\n\n## Index\n- [[${WEB}/tooling]]\n- [[personal/api]]\n`,
			[`${WEB}/tooling.md`]:
				"# tooling\n- Use pnpm [source: https://ytimesy.test/?chat=a; added: 2026-10-01]\n",
			"personal/api.md":
				"# api\n- Errors are JSON [scope: always; source: b]\n",
			"projects/other--9/x.md": "# x\n- Not this project\n",
		};
		const order: string[] = [];
		const run = async (text: string) => {
			const setup = harness({
				files,
				chats: [
					chat("11111111-1111-4111-8111-111111111111", [
						item({ kind: "userMessage", id: "1", text }),
					]),
				],
				answer:
					'{"entries":[{"file":"tooling.md","text":"Node is pinned to 22"}]}',
			});
			const { recordUsage, recordSaved, warmLines } = setup.deps;
			setup.deps.recordUsage = async (row) => {
				order.push("usage");
				return recordUsage(row);
			};
			setup.deps.recordSaved = async (...args) => {
				order.push("saved");
				return recordSaved(...args);
			};
			setup.deps.warmLines = async (...args) => {
				order.push("warm");
				return warmLines(...args);
			};
			await runMemorySave(
				"u1",
				"11111111-1111-4111-8111-111111111111",
				setup.deps,
			);
			return setup.calls.agent[0];
		};
		const first = await run("Always pin Node to 22");
		const second = await run("Also, our API is versioned by header");
		// Static instructions, then the whole memory in file order; the message last.
		const a = String(first.messages[0].content);
		const b = String(second.messages[0].content);
		const prefix = a.slice(0, a.indexOf("Project of this chat"));
		expect(b.startsWith(prefix)).toBe(true);
		// Only this chat's scope: personal/ and its project's folder.
		expect(prefix).toContain(
			`Existing memory files: personal/api.md, ${WEB}/tooling.md\n\nThe user's memory for this chat, every line (id: line):\npersonal/api.md:2: - Errors are JSON [scope: always]\n${WEB}/tooling.md:2: - Use pnpm [added: 2026-10-01]\n`,
		);
		expect(a).toContain(
			`Project of this chat: acme/web (entries go to ${WEB}/ unless "personal" is set)`,
		);
		expect(a).not.toContain("Not this project");
		expect(a.endsWith("Always pin Node to 22")).toBe(true);
		expect(first.instructions).toBe(second.instructions);
		expect(first.cacheScopeId).toBe("memory-save:u1");
		// The usage row says the save is done: after the lines are embedded and shown.
		expect(order.slice(0, 3)).toEqual(["warm", "saved", "usage"]);
	});

	it("lists only the best matches, still in file order, when the memory is large", async () => {
		const { saveHookListing } = await import("./memory-jobs");
		const big = Array.from(
			{ length: 400 },
			(_, index) =>
				`- Fact number ${index} about the warehouse ${"x".repeat(40)} [source: s${index}]`,
		).join("\n");
		const listing = await saveHookListing(
			{
				"a.md": `# a\n${big}\n`,
				"b.md": "# b\n- Use pnpm for installs\n",
			},
			"install with pnpm",
			"2026-10-15",
			async () => null,
		);
		expect(listing.whole).toBe(false);
		expect(listing.lines.map((entry) => entry.text)).toContain(
			"Use pnpm for installs",
		);
		const ids = listing.lines.map((entry) => `${entry.path}:${entry.line}`);
		expect(ids).toEqual(
			[...listing.lines]
				.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line)
				.map((entry) => `${entry.path}:${entry.line}`),
		);
	});

	it("retries a failed model call once, but not a timeout", async () => {
		const failing = (name: string, failures: number) => {
			const setup = harness({
				files: { "MEMORY.md": "# Memory\n\n## Index\n" },
				chats,
				answer:
					'{"entries":[{"file":"tooling.md","text":"Uses pnpm, never npm"}]}',
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
				[{ file: "tooling.md", text: "Uses pnpm, never npm" }],
				{ source: "s", today: "2026-10-15" },
			),
		).toEqual([]);
	});
});

describe("save hook scope", () => {
	const ID = "11111111-1111-4111-8111-111111111111";
	const said = (text: string, project = true) => {
		const row = chat(ID, [item({ kind: "userMessage", id: "1", text })]);
		return project ? row : { ...row, project: null, projectRef: null };
	};

	it("saves to personal/ only an entry the model marks personal, with a reason", async () => {
		const { deps, commits } = harness({
			chats: [said("I always want short replies; also we deploy on Fly")],
			answer:
				'{"entries":[{"file":"style.md","text":"Prefers short replies","personal":"how they like answers in every project"},{"file":"deploy.md","text":"Deploys on Fly"}]}',
		});
		expect(await runMemorySave("u1", ID, deps)).toBe("saved");
		const paths = (commits[0].changes as { path: string }[]).map(
			(change) => change.path,
		);
		expect(paths).toEqual(
			expect.arrayContaining(["personal/style.md", `${WEB}/deploy.md`]),
		);
	});

	it("keeps only personal entries in a chat without a project", async () => {
		const { deps, commits, calls } = harness({
			chats: [
				said("Remember: I prefer tabs; this script uses argparse", false),
			],
			answer:
				'{"entries":[{"file":"style.md","text":"Prefers tabs","personal":"their style everywhere"},{"file":"cli.md","text":"The script uses argparse"}]}',
		});
		expect(await runMemorySave("u1", ID, deps)).toBe("saved");
		expect(commits[0].changes).toEqual([
			expect.objectContaining({ path: "personal/style.md" }),
			expect.objectContaining({ path: "MEMORY.md" }),
		]);
		expect(String(calls.agent[0].messages[0].content)).toContain(
			"Project of this chat: (none): save only personal entries",
		);
	});

	it("skips the model call for a message with nothing durable in it", async () => {
		const { deps, calls } = harness({
			chats: [said("run the tests again please")],
			answer: '{"entries":[]}',
		});
		expect(await runMemorySave("u1", ID, deps)).toBe("no-cue");
		expect(calls.agent).toEqual([]);
		// Recorded as found-nothing, so other chats neither wait for it nor show it.
		expect(calls.usage).toEqual([
			expect.objectContaining({
				kind: "save",
				steps: 0,
				outcome: "skipped:nothing-new",
			}),
		]);
	});

	it("drops an entry that says what a line already says, by embedding and words", async () => {
		const files = {
			[`${WEB}/tooling.md`]:
				"# tooling\n- Uses pnpm for every install [source: a]\n",
		};
		const answer =
			'{"entries":[{"file":"tooling.md","text":"Uses pnpm for all installs"},{"file":"tooling.md","text":"Node is pinned to 22"}]}';
		const { deps, commits } = harness({
			files,
			chats: [said("From now on pin Node to 22; we use pnpm for all installs")],
			answer,
			closest: async (_user, lines, entries) =>
				entries.map((entry) => ({
					line: lines[0],
					similarity: entry.text.includes("pnpm") ? 0.95 : 0.4,
				})),
		});
		expect(await runMemorySave("u1", ID, deps)).toBe("saved");
		const content = (commits[0].changes as { content: string }[])[0].content;
		expect(content).toContain("Node is pinned to 22");
		expect(content).not.toContain("Uses pnpm for all installs");
	});

	it("keeps a close entry that changes the word that matters", async () => {
		const line = {
			path: "t.md",
			line: 1,
			raw: "- Use npm for installs",
			text: "Use npm for installs",
			meta: {},
		};
		const kept = await withoutNearDuplicates(
			[{ file: "t.md", text: "Use pnpm for installs" }],
			[line],
			async () => [{ line, similarity: 0.93 }],
		);
		expect(kept).toHaveLength(1);
	});

	it("does not count another project's line as already known", () => {
		const files = {
			"projects/acme-api--8/tooling.md": "# tooling\n- Uses pnpm [source: x]\n",
		};
		const changes = saveHookChanges(
			files,
			[{ file: "tooling.md", text: "Uses pnpm", folder: WEB }],
			{ source: "s", today: "2026-10-15", folder: WEB },
		);
		expect(changes.map((change) => change.path)).toContain(`${WEB}/tooling.md`);
	});

	it("moves a repo from before the layout first, as its own commit", async () => {
		const { deps, commits } = harness({
			legacy: true,
			files: {
				"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
				"tooling.md":
					"# tooling\n- Prefers tabs [added: 2026-10-01]\n- Uses Vitest [project: acme/web; added: 2026-10-02]\n",
			},
			chats: [said("Remember that the API is versioned by header")],
			answer: '{"entries":[]}',
		});
		expect(await runMemorySave("u1", ID, deps)).toBe("nothing-new");
		expect(commits).toHaveLength(1);
		expect(commits[0].message).toBe("Reorganize memory by project");
		expect(commits[0].changes).toEqual(
			expect.arrayContaining([
				{ path: "tooling.md", content: null },
				{
					path: "personal/tooling.md",
					content: "# tooling\n- Prefers tabs [added: 2026-10-01]\n",
				},
				{
					path: `${WEB}/tooling.md`,
					content:
						"# tooling\n\n- Uses Vitest [project: acme/web; added: 2026-10-02]\n",
				},
				{ path: ".memory-layout", content: "2\nsort-personal: pending\n" },
			]),
		);
	});

	it("has the next dream sort personal/ after the move, then stops asking", async () => {
		const { deps, calls, commits, call } = harness({
			files: {
				".memory-layout": "2\nsort-personal: pending\n",
				"personal/tooling.md": "# tooling\n- Web pins Node 22\n",
			},
			chats: [said("Remember that the API is versioned by header")],
			// A review ran yesterday: only the pending sort brings this one.
			lastReview: new Date("2026-10-14T00:00:00Z"),
			script: async (tools) => {
				await call(tools, "commit", { message: "Sorted personal" });
			},
		});
		expect(await runMemoryDream("u1", deps, 5)).toBe("committed");
		expect(String(calls.agent[0].messages[0].content)).toContain(
			"Sort personal/",
		);
		expect(commits.at(-1)?.changes).toEqual([
			{ path: ".memory-layout", content: "2\n" },
		]);
	});
});
