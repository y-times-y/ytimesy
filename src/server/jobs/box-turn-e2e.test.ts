import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpToolName } from "../../domain/mcp-tool-call";
import type { VmEnsureResponse } from "../../domain/turn-box-vm-protocol";
import type { GuestExec } from "../claude-box-tools/identity-machines";
import { fakeEdge } from "../edge/turn-box-fake-edge";

/**
 * A whole turn through the real `runApiTurn` on a box: claim, steps, tools on
 * a fake VM, commit, finalize, with the fake edge (the real routes over an
 * in-memory turn table), a fake model upstream and a fake Freestyle guest.
 * The database adapter is mocked to THROW and record who asked, and a clean
 * environment is watched for secret reads. Nothing here touches a real
 * Durable Object, Postgres, Worker, Freestyle or AWS box.
 */
const dbCalls = vi.hoisted(() => ({ stacks: [] as string[] }));
vi.mock("../adapters/database", () => ({
	database: () => {
		const error = new Error("The box has no database.");
		dbCalls.stacks.push(error.stack ?? "");
		throw error;
	},
	withDatabaseScope: async (_: unknown, run: () => unknown) => run(),
}));

import { runTurnRunnerBox } from "./box-runner";
import { TurnBoxEdgeClient } from "./turn-box-client";
import { boxWorkspaceMachines } from "./turn-box-vm-machines";

const CLEAN_ENV = {
	YTIMESY_EDGE_URL: "https://edge.test",
	YTIMESY_BOX_IDENTITY: "ytbi1.x.y",
	YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
	TURN_BOX_EDGE_PUBLIC_KEY: "public",
	PATH: "/usr/bin",
	HOME: "/home/box",
};
const SECRET_NAME =
	/DATABASE|_API_KEY|FREESTYLE|TOKEN_VAULT|PRIVATE_KEY|_SECRET/i;
const PACKET = JSON.stringify({
	scope: "",
	revision: null,
	nestedInstructionFiles: [],
	nestedInstructionFilesTruncated: false,
	instructions: [],
	referencedDocuments: [],
	configuration: [],
	documentLimitReached: false,
	skills: [],
	skillLimitReached: false,
	scopeFiles: [],
	scopeFilesTruncated: false,
	scopeFilesUnavailable: false,
	unreadableFiles: [],
});

type ModelStep =
	| { text: string }
	| { tool: string; input: Record<string, unknown> };
const sse = (step: ModelStep) => {
	const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
		`data: ${JSON.stringify({
			id: "c",
			object: "chat.completion.chunk",
			created: 1,
			model: "m1",
			choices: [{ index: 0, delta, finish_reason: finish }],
			...(usage ? { usage } : {}),
		})}\n\n`;
	const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
	const body =
		"text" in step
			? chunk({ role: "assistant", content: step.text }, null) +
				chunk({}, "stop", usage)
			: chunk(
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: {
									name: step.tool,
									arguments: JSON.stringify(step.input),
								},
							},
						],
					},
					null,
				) + chunk({}, "tool_calls", usage);
	return new Response(`${body}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
};

async function scenario(input: {
	model: ModelStep[];
	/** Called when the n-th (1-based) model request reaches the upstream. */
	onModel?: (n: number, edge: Awaited<ReturnType<typeof fakeEdge>>) => void;
	env?: Record<string, string>;
	commit?: { notice?: string; publish: boolean } | null;
}) {
	const edge = await fakeEdge();
	edge.row.messages = [{ role: "user", content: "add a file" }];
	edge.row.items = [
		{ kind: "userMessage", id: "m1", text: "add a file" } as never,
	];
	edge.row.connection_id = "c1";
	edge.row.model_id = "m1";
	edge.queue.push({ ...edge.row });
	const requests: string[] = [];
	const finalizes: unknown[] = [];
	const finalize = edge.ops.finalize;
	edge.ops.finalize = async (turn, body) => {
		finalizes.push(body);
		return finalize(turn, body);
	};
	let modelCalls = 0;
	(edge.deps as { upstream: unknown }).upstream = async () => {
		modelCalls += 1;
		input.onModel?.(modelCalls, edge);
		const step = input.model[Math.min(modelCalls, input.model.length) - 1];
		return sse(step as ModelStep);
	};
	const owner = {
		id: edge.row.session_id,
		userId: edge.row.user_id,
		projectId: "p1",
		workspaceId: "w1",
		harness: "api",
		providerRef: "vm-1",
		parentSessionId: null,
		title: "t",
		briefing: null,
		items: [],
		listedModelId: null,
		turnStatus: "running",
		status: "ready",
		taskPrompt: null,
		taskState: null,
		taskPlacement: null,
		taskAccess: null,
		taskSummary: null,
		taskReviewState: null,
		taskBranch: null,
		createdAt: "",
		updatedAt: "",
	};
	const defaults: Record<string, unknown> = {
		sessionAncestors: [],
		importedSessions: [],
		lifecycleContinuations: [],
		pluginSkillIndex: [],
		otherRunningTurnOnMachine: false,
		isDevEvalUser: false,
		peerInboxRead: [],
		coordinateTurn: true,
		projectSecretNames: { names: [] },
		sessionMetadata: owner,
		modelConnection: {
			id: "c1",
			provider: "compatible",
			label: "x",
			baseUrl: "https://llm.test/v1",
			models: [{ id: "m1", label: "m1" }],
			revision: "rev-1",
		},
		commitTurn: input.commit === undefined ? { publish: false } : input.commit,
	};
	const ports = edge.state.ports as Record<string, unknown>;
	for (const op of [
		...Object.keys(defaults),
		"projectYMode",
		"conversationPointCodeRef",
		"verificationBaseline",
		"preparedCheckoutDirectory",
		"projectDerivedValue",
		"sessionDerivedValue",
		"pluginSkillBody",
		"harnessVariant",
		"savePreparedCheckoutDirectory",
		"saveSessionDerivedValue",
		"archiveContext",
		"releaseHeldTaskEvents",
		"analytics",
		"userHubNote",
		"crewWaiting",
		"writeSecretsToVm",
		"ensureCodePoint",
	])
		ports[op] = async () => defaults[op] ?? null;

	const vmWorld = {
		ensures: 0,
		releases: 0,
		commands: [] as string[],
		tokens: new Set<string>(),
	};
	const vmEdge = {
		ensure: async (): Promise<VmEnsureResponse> => {
			vmWorld.ensures += 1;
			return {
				vm: "vm-1",
				grant:
					vmWorld.ensures === 1
						? { token: "scoped-token", linuxUser: "ubuntu", redactOnVm: false }
						: null,
			};
		},
		pause: async () => "skipped" as const,
		op: async () => ({}),
		release: async () => {
			vmWorld.releases += 1;
		},
	};
	const guest =
		(grant: { token: string }): GuestExec =>
		async (options) => {
			vmWorld.tokens.add(grant.token);
			vmWorld.commands.push(options.command.slice(0, 200));
			const command = options.command;
			if (command.includes("ytimesy-project-cwd"))
				return { stdout: "/home/ubuntu/repo", stderr: "", statusCode: 0 };
			if (command.startsWith("python3 -c"))
				return { stdout: PACKET, stderr: "", statusCode: 0 };
			return { stdout: "ok\n", stderr: "", statusCode: 0 };
		};

	const counted = (async (target: RequestInfo | URL, init?: RequestInit) => {
		let next = init;
		if (typeof next?.body === "string") {
			// A real fetch computes it; the in-process routes need it for the model proxy.
			const headers = new Headers(next.headers);
			headers.set(
				"content-length",
				String(new TextEncoder().encode(next.body).length),
			);
			next = { ...next, headers };
		}
		const path = new URL(String(target)).pathname;
		let label = path.replace("/box/v1/", "");
		if (path.endsWith("/port") && typeof next?.body === "string")
			label = `port:${(JSON.parse(next.body) as { op: string }).op}`;
		requests.push(label);
		return edge.fetchEdge(target, next);
	}) as typeof fetch;
	const client = new TurnBoxEdgeClient({
		edgeUrl: "https://edge.test",
		identity: edge.identity,
		fetch: counted,
		now: () => edge.state.now,
		socket: async () => {
			throw new Error("no socket in this test");
		},
	});

	// A clean environment, watched: no secret-shaped variable may be read.
	const reads: string[] = [];
	const env = new Proxy(
		{ ...CLEAN_ENV, ...(input.env ?? {}) } as Record<string, string>,
		{
			get(target, key) {
				if (typeof key === "string" && SECRET_NAME.test(key)) reads.push(key);
				return target[key as string];
			},
		},
	);
	const realEnv = process.env;
	const watched = new Proxy(realEnv, {
		get(target, key) {
			if (typeof key === "string" && SECRET_NAME.test(key)) reads.push(key);
			return target[key as string];
		},
	});

	const run = async () => {
		process.env = watched;
		try {
			const box = await runTurnRunnerBox({
				env,
				client,
				machinesFor: () =>
					boxWorkspaceMachines({ edge: vmEdge, guest, now: () => Date.now() }),
				signalHandlers: false,
			});
			await box.dispatcher.drain();
		} finally {
			process.env = realEnv;
		}
	};
	return {
		edge,
		run,
		requests,
		finalizes,
		vmWorld,
		reads,
		modelCalls: () => modelCalls,
		owner,
	};
}

beforeEach(() => {
	dbCalls.stacks.length = 0;
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("a coding turn on a box, claim to finalize", () => {
	it("answers with text: completes, no database, no secret read", async () => {
		const s = await scenario({ model: [{ text: "Done." }] });
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.reads).toEqual([]);
		expect(s.vmWorld.ensures).toBe(1);
		expect(s.vmWorld.tokens).toEqual(new Set(["scoped-token"]));
		console.log("E2E answer", s.requests.length, s.requests.join(" "));
	});

	it("runs a tool on the VM, commits at the edge and asks it to publish at finalize", async () => {
		const s = await scenario({
			model: [
				{ tool: "execute_command", input: { command: "echo hi > a.txt" } },
				{ text: "Added a.txt." },
			],
			commit: { publish: true },
		});
		await s.run();
		console.log(
			"E2E coding",
			s.requests.length,
			s.requests.join(" "),
			s.vmWorld.commands,
		);
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.edge.calls).toContain("port:commitTurn");
		expect(s.finalizes).toHaveLength(1);
		expect((s.finalizes[0] as { publish?: boolean }).publish).toBe(true);
		expect(s.vmWorld.commands.length).toBeGreaterThan(1);
	});
});

describe("helpers from a box (the subagent port)", () => {
	it("starts a reader, waits for its report and finishes, all through the edge", async () => {
		const s = await scenario({
			model: [
				{
					tool: "agent",
					input: {
						role: "researcher",
						title: "Read package metadata",
						brief: "Read package.json and report its name.",
						wait: true,
					},
				},
				{ text: "The package is called demo." },
			],
		});
		// The chat's model: a helper inherits it.
		Object.assign(s.owner, { listedModelId: "c1:m1" });
		const child = {
			...s.owner,
			id: "22222222-2222-4222-8222-222222222222",
			parentSessionId: s.owner.id,
			title: "Read package metadata",
			taskState: "draft",
			taskPlacement: "shared",
			taskAccess: "read_only",
		};
		const deps: string[] = [];
		let reports = 0;
		(s.edge.state.ports as Record<string, unknown>).subagent = async (args: {
			dep: string;
			args: unknown[];
		}) => {
			deps.push(args.dep);
			switch (args.dep) {
				case "usageWindowsOpen":
				case "saveSpec":
				case "mergeFork":
				case "markFailed":
				case "stop":
					return null;
				case "routes":
					return [];
				case "ancestors":
					return [];
				case "tree":
					return [s.owner, ...(deps.includes("openTask") ? [child] : [])];
				case "itemsOfKinds":
					return [];
				case "openTask":
					return child;
				case "start":
					return { id: child.id, machineId: null };
				case "takeReport":
					reports += 1;
					return reports < 2
						? null
						: { outcome: "completed", report: "The name is demo." };
				default:
					throw new Error(`unexpected dep ${args.dep}`);
			}
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.reads).toEqual([]);
		expect(deps).toContain("openTask");
		expect(deps).toContain("start");
		expect(deps.filter((dep) => dep === "takeReport").length).toBe(2);
		const result = JSON.stringify(s.edge.row.items);
		expect(result).toContain("The name is demo.");
		console.log("E2E helper", deps.join(" "));
	}, 60_000);
});

describe("MCP servers from a box (listed and called by the edge)", () => {
	it("offers the edge's MCP tools and sends the call there", async () => {
		const name = mcpToolName("docs", "search");
		const s = await scenario({
			model: [{ tool: name, input: { query: "box" } }, { text: "Found it." }],
		});
		const calls: unknown[] = [];
		const ports = s.edge.state.ports as Record<string, unknown>;
		ports.mcpListing = async () => ({
			catalog: [
				{
					name,
					server: "docs",
					tool: "search",
					description: "Search the docs",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			],
			purposes: {},
			unavailable: [],
		});
		ports.mcpCall = async (args: unknown) => {
			calls.push(args);
			return { content: [{ type: "text", text: "box docs page" }] };
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.reads).toEqual([]);
		expect(calls).toEqual([
			{ server: "docs", tool: "search", input: { query: "box" } },
		]);
		expect(JSON.stringify(s.edge.row.items)).toContain("box docs page");
		// Listed once for the turn, whatever the number of steps.
		expect(s.requests.filter((r) => r === "port:mcpListing").length).toBe(1);
	}, 60_000);
});

describe("Stop and lease loss mid-step", () => {
	it("Stop requested while the model streams: the box stops, commits nothing, publishes nothing", async () => {
		const s = await scenario({
			model: [
				{ tool: "execute_command", input: { command: "echo hi > a.txt" } },
				{ text: "Added a.txt." },
			],
			commit: { publish: true },
			onModel: (n, edge) => {
				if (n === 1) edge.row.cancel_requested = true;
			},
		});
		await s.run();
		expect(s.edge.row.state).toBe("cancelled");
		expect(s.edge.calls).not.toContain("port:commitTurn");
		expect(s.modelCalls()).toBe(1);
		// A stopped turn never asks the edge to publish.
		for (const body of s.finalizes)
			expect((body as { publish?: boolean }).publish).toBeUndefined();
		expect(dbCalls.stacks).toEqual([]);
	});

	it("lease taken over while the model streams: the stale box writes nothing and stops", async () => {
		let snapshot = "";
		const s = await scenario({
			model: [
				{ tool: "execute_command", input: { command: "echo hi > a.txt" } },
				{ text: "Added a.txt." },
			],
			commit: { publish: true },
			onModel: (n, edge) => {
				if (n === 1) {
					// Another box now owns the turn.
					edge.row.lease_id = "66666666-6666-4666-8666-666666666666";
					snapshot = JSON.stringify([edge.row.messages, edge.row.items]);
				}
			},
		});
		const started = Date.now();
		await s.run();
		// No 5 s/10 s/15 s retry pauses for a turn that is no longer ours.
		expect(Date.now() - started).toBeLessThan(4_000);
		// The new owner's row is exactly as it was: nothing the stale lease wrote.
		expect(JSON.stringify([s.edge.row.messages, s.edge.row.items])).toBe(
			snapshot,
		);
		expect(s.edge.row.state).toBe("running");
		expect(s.edge.calls).not.toContain("port:commitTurn");
		expect(s.modelCalls()).toBe(1);
		expect(s.finalizes.length).toBeLessThanOrEqual(1);
	});
});

describe("request counts (Worker requests a box makes to the edge)", () => {
	it("a 40-step tool turn", async () => {
		const model: ModelStep[] = [
			...Array.from({ length: 40 }, () => ({
				tool: "execute_command",
				input: { command: "echo hi" },
			})),
			{ text: "Done." },
		];
		const s = await scenario({ model });
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		const counts = new Map<string, number>();
		for (const label of s.requests)
			counts.set(label, (counts.get(label) ?? 0) + 1);
		const count = (label: string) => counts.get(label) ?? 0;
		// Measured: 431 requests with the per-turn memos, the renewal skip, the
		// local history and the checkpoint's own renewal switched off (about 10.5
		// a step), 102 with them (about 2.1 a step). Pinned so a regression shows.
		// The floor is one model request and one checkpoint per step; the
		// ~100-per-40-steps target is met only because the loop writes one
		// checkpoint per step. Time-based costs (a lease renewal and a room
		// renewal every ~10 s, progress without a socket) are not in this fast run.
		expect(s.requests.length).toBeLessThanOrEqual(110);
		expect(count("model/chat/completions")).toBe(41);
		expect(count("checkpoint")).toBeLessThanOrEqual(43);
		expect(count("history")).toBe(1); // only the claim's; steps reuse what was saved
		for (const once of [
			"port:modelConnection",
			"port:sessionMetadata",
			"port:projectYMode",
			"port:projectSecretNames",
			"port:importedSessions",
			"port:pluginSkillIndex",
			"port:savePreparedCheckoutDirectory",
		])
			expect(count(once), once).toBeLessThanOrEqual(1);
		expect(count("port:coordinateTurn")).toBeLessThanOrEqual(2); // acquire, release
		expect(count("renew")).toBeLessThanOrEqual(2);
		expect(count("port:peerInboxRead")).toBeLessThanOrEqual(2);
		expect(count("port:analytics")).toBeLessThanOrEqual(3);
		console.log(
			"E2E 40 steps",
			s.requests.length,
			JSON.stringify(Object.fromEntries(counts)),
		);
	}, 120_000);
});
