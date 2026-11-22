import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	/** A real local shell as the VM: commands run with bash in this directory (its repo/). */
	shell?: string;
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
		mcpListing: { catalog: [], purposes: {}, unavailable: [] },
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
			if (input.shell) {
				if (command.includes("ytimesy-project-cwd"))
					return { stdout: `${input.shell}/repo`, stderr: "", statusCode: 0 };
				const ran = spawnSync("bash", ["-c", command], {
					...(options.stdin
						? { input: Buffer.from(options.stdin, "base64") }
						: {}),
					cwd: `${input.shell}/repo`,
					env: {
						// Its own sudo refuses: the VM's setup (linking commands
						// into /usr/local/bin, installing packages) must never
						// reach the machine running the tests.
						PATH: `${input.shell}/shim:${process.env.PATH ?? "/usr/bin:/bin"}`,
						HOME: `${input.shell}/home`,
					},
					encoding: "utf8",
					timeout: 30_000,
				});
				return {
					stdout: ran.stdout ?? "",
					stderr: ran.stderr ?? "",
					statusCode: ran.status ?? 1,
				};
			}
			if (command.includes("ytimesy-project-cwd"))
				return { stdout: "/home/ubuntu/repo", stderr: "", statusCode: 0 };
			// A reader helper's commands run wrapped (as the reader user, base64).
			if (
				command.startsWith("python3 -c") ||
				command.includes(
					Buffer.from("python3 -c").toString("base64").slice(0, 12),
				)
			)
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

describe("the super agent (Y²) and helpers on a box", () => {
	it("a Y² turn lists and messages threads through the edge, never the database", async () => {
		const THREAD = "33333333-3333-4333-8333-333333333333";
		const s = await scenario({
			model: [
				{ tool: "threads", input: {} },
				{ tool: "message_thread", input: { id: THREAD, text: "hi" } },
				{ text: "Done." },
			],
		});
		Object.assign(s.owner, { listedModelId: "c1:m1" });
		const ports = s.edge.state.ports as Record<string, unknown>;
		ports.projectYMode = async () => ({
			enabled: true,
			ySquaredId: s.owner.id,
		});
		const deps: string[] = [];
		ports.ySquared = async (a: { dep: string; args: unknown[] }) => {
			deps.push(a.dep);
			if (a.dep === "crewList")
				return {
					reconciled: true,
					rows: [
						{
							sessionId: THREAD,
							title: "Fix login",
							state: "working",
							waitingOn: null,
							prUrl: null,
							lastReply: null,
							lastRequest: "fix it",
							updatedAt: 1,
							createdAt: 1,
							lastActiveAt: 1,
							workingSince: 1,
						},
					],
				};
			if (a.dep === "metadata")
				return {
					...s.owner,
					id: a.args[1],
					parentSessionId: null,
					agentRole: null,
					title: "Fix login",
					turnStatus: "idle",
				};
			if (a.dep === "send") return { turnStatus: "running" };
			return null;
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.reads).toEqual([]);
		expect(deps).toEqual(["crewList", "metadata", "crewNoteY2Sent", "send"]);
		const result = JSON.stringify(s.edge.row.items);
		expect(result).toContain("Fix login");
		expect(result).toContain("its turn started");
	}, 60_000);

	it("a helper's own turn counts its steps through the edge and leaves its report to the edge's settle", async () => {
		const s = await scenario({
			model: [{ text: "Report: two files." }],
		});
		Object.assign(s.owner, {
			parentSessionId: "44444444-4444-4444-8444-444444444444",
			agentRole: "researcher",
			taskState: "running",
			taskAccess: "read_only",
			taskPlacement: "shared",
			listedModelId: "c1:m1",
		});
		const ports = s.edge.state.ports as Record<string, unknown>;
		const steps: string[] = [];
		ports.helperStep = async (a: { op: string }) => {
			steps.push(a.op);
			return a.op === "record" ? { steps: 1, budget: null } : [];
		};
		ports.helperMemory = async () => false;
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.reads).toEqual([]);
		expect(steps).toContain("record");
		// Written after finalize by the edge (turn-box-edge-work.ts), not by the box.
		expect(s.edge.calls).not.toContain("port:saveTaskResult");
	}, 60_000);
});

describe("a side chat on a box", () => {
	for (const parentRunning of [false, true])
		it(`runs on the parent's checkout and reads Main's state through the edge (Main ${parentRunning ? "running: read-only" : "idle"})`, async () => {
			const PARENT = "44444444-4444-4444-8444-444444444444";
			// A real shell as the VM: a shared writer's commands run wrapped.
			const dir = mkdtempSync(join(tmpdir(), "box-side-"));
			for (const sub of ["repo", "home", "shim"]) mkdirSync(join(dir, sub));
			writeFileSync(join(dir, "shim", "sudo"), "#!/bin/sh\nexit 1\n", {
				mode: 0o755,
			});
			writeFileSync(join(dir, "repo", "README.md"), "# x\n");
			const s = await scenario({
				model: [{ text: "Answered in the side chat." }],
				commit: { publish: false },
				shell: dir,
			});
			Object.assign(s.owner, {
				parentSessionId: PARENT,
				agentRole: "writer",
				agentBudget: {
					sideChat: true,
					steps: 10_000,
					minutes: 1440,
					tokens: 5_000_000,
				},
				taskPlacement: "shared",
				taskAccess: "read_write",
				listedModelId: "c1:m1",
			});
			const ports = s.edge.state.ports as Record<string, unknown>;
			const own = ports.sessionMetadata as (a: {
				sessionId: string;
			}) => unknown;
			const asked: string[] = [];
			ports.sessionMetadata = async (a: { sessionId: string }) => {
				asked.push(a.sessionId);
				return a.sessionId === PARENT
					? {
							...s.owner,
							id: PARENT,
							parentSessionId: null,
							agentRole: null,
							agentBudget: null,
							turnStatus: parentRunning ? "running" : "idle",
						}
					: own(a);
			};
			ports.helperMemory = async () => false;
			await s.run();
			expect(s.edge.row.state).toBe("completed");
			expect(dbCalls.stacks).toEqual([]);
			expect(s.reads).toEqual([]);
			// Main's state decides read-only; it is read through the edge.
			expect(asked).toContain(PARENT);
			// A side chat is not a helper: no step budget, no report to Main.
			expect(s.edge.calls).not.toContain("port:helperStep");
			expect(s.edge.calls).not.toContain("port:saveTaskResult");
			expect(JSON.stringify(s.edge.row.items)).toContain(
				"Answered in the side chat.",
			);
		}, 60_000);
});

describe("model failover on a box", () => {
	it("a route that keeps failing switches to the edge's planned fallback and the turn completes there", async () => {
		const s = await scenario({ model: [{ text: "unused" }] });
		Object.assign(s.owner, { listedModelId: "c1:m1" });
		// The connection serves both models; the fallback is its m2.
		(s.edge.state.ports as Record<string, unknown>).modelConnection =
			async () => ({
				id: "c1",
				provider: "compatible",
				label: "x",
				baseUrl: "https://llm.test/v1",
				models: [
					{ id: "m1", label: "m1" },
					{ id: "m2", label: "m2" },
				],
				revision: "rev-1",
			});
		let calls = 0;
		const plans: unknown[] = [];
		// The chosen model (m1) refuses (a provider rate limit); only the
		// fallback (m2) answers, so the next step must really run on it.
		const models: string[] = [];
		(s.edge.deps as { upstream: unknown }).upstream = async (
			_input: unknown,
			init?: RequestInit,
		) => {
			calls += 1;
			const body = init?.body ? await new Response(init.body).text() : "{}";
			const model = String((JSON.parse(body) as { model?: string }).model);
			models.push(model);
			if (model !== "m2")
				return Response.json(
					{ error: { type: "rate_limit_error", message: "slow down" } },
					{ status: 400 },
				);
			return sse({ text: "Answered on the fallback." });
		};
		(s.edge.state.ports as Record<string, unknown>).planFailover = async (
			input: unknown,
		) => {
			plans.push(input);
			const route = {
				connectionId: "c1",
				connectionRevision: "rev-1",
				modelId: "m1",
			};
			return {
				decision: {
					kind: "switch",
					candidate: {
						route: { ...route, modelId: "m2" },
						connectionKey: "c1",
						connectionLabel: "Backup",
						modelLabel: "M2",
						paid: false,
						sameModel: false,
					},
				},
				failing: { route, label: { model: "M1", connection: "Main" } },
				previous: null,
			};
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(plans).toEqual([
			{ reason: "rate-limited", child: false, allowCustom: false },
		]);
		expect(models).toEqual(["m1", "m2"]);
		expect(calls).toBe(2);
		const result = JSON.stringify(s.edge.row.items);
		expect(result).toContain("Answered on the fallback.");
		expect(result).toContain("modelSwitch");
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

describe("memory from a box (read and written by the edge)", () => {
	it("adds the edge's instructions and recalled lines, clones and saves through the edge", async () => {
		const s = await scenario({
			model: [
				{ tool: "execute_command", input: { command: "echo hi" } },
				{ text: "Done." },
			],
		});
		const ops: string[] = [];
		(s.edge.state.ports as Record<string, unknown>).memory = async (args: {
			op: string;
			items?: unknown[];
			messages?: unknown[];
		}) => {
			ops.push(args.op);
			switch (args.op) {
				case "init":
					return { mode: "full", instructions: "MEMORY-INSTRUCTIONS-XYZ" };
				case "prepareVm":
					return { tokens: ["mem-token-123"] };
				case "parts":
					return {
						parts: ["<memory>\nRecalled: the user prefers pnpm.\n</memory>"],
						recall: { head: "h1", lines: [] },
					};
				case "recordSaved":
					return args.items ?? [];
				default:
					return null;
			}
		};
		const bodies: string[] = [];
		const deps = s.edge.deps as unknown as {
			upstream: (request: unknown, init?: RequestInit) => Promise<unknown>;
		};
		const upstream = deps.upstream;
		deps.upstream = async (request: unknown, init?: RequestInit) => {
			const copy = new Request(request as RequestInfo, init);
			bodies.push(await copy.clone().text());
			return upstream(copy);
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(s.reads).toEqual([]);
		expect(ops).toContain("init");
		expect(ops).toContain("parts");
		// The save hook is the edge's, after finalize (afterBoxTurnSettled).
		expect(ops).not.toContain("afterTurn");
		expect(ops).toContain("recordSaved");
		const first = bodies[0] ?? "";
		expect(first).toContain("MEMORY-INSTRUCTIONS-XYZ");
		expect(first).toContain("the user prefers pnpm");
	}, 60_000);
});

describe("tools the edge runs whole (secrets, push approval)", () => {
	it("saves a secret through the edge: the value never reaches the box", async () => {
		const s = await scenario({
			model: [
				{
					tool: "save_project_secret",
					input: {
						name: "GH_TOKEN",
						valueCommand: "gh auth token",
						kind: "runtime",
						scope: "project",
					},
				},
				{ text: "Saved." },
			],
		});
		const calls: { tool: string; input: unknown }[] = [];
		(s.edge.state.ports as Record<string, unknown>).remoteTool = async (args: {
			tool: string;
			input: unknown;
		}) => {
			calls.push(args);
			return { saved: true, name: "GH_TOKEN", note: "Saved to this project." };
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(calls).toEqual([
			{
				tool: "save_project_secret",
				input: {
					name: "GH_TOKEN",
					valueCommand: "gh auth token",
					kind: "runtime",
					scope: "project",
				},
			},
		]);
		// The box never ran the value command on the VM itself.
		expect(s.vmWorld.commands.some((c) => c.includes("gh auth token"))).toBe(
			false,
		);
		expect(JSON.stringify(s.edge.row.items)).toContain(
			"Saved to this project.",
		);
	}, 60_000);

	it("asks for a push approval through the edge with the checkout path", async () => {
		const s = await scenario({
			model: [
				{
					tool: "request_push_approval",
					input: { repo: "acme/app", branch: "main", summary: "ship it" },
				},
				{ text: "Waiting for the push." },
			],
		});
		const calls: { tool: string; cwd?: string }[] = [];
		(s.edge.state.ports as Record<string, unknown>).remoteTool = async (args: {
			tool: string;
			cwd?: string;
		}) => {
			calls.push(args);
			return { requested: true };
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
		expect(dbCalls.stacks).toEqual([]);
		expect(calls.map((c) => c.tool)).toEqual(["request_push_approval"]);
		expect(calls[0]?.cwd).toBe("/home/ubuntu/repo");
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

describe("MCP listing failure on a box", () => {
	it("leaves the turn without MCP tools instead of failing it", async () => {
		const s = await scenario({ model: [{ text: "Done." }] });
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		(s.edge.state.ports as Record<string, unknown>).mcpListing = async () => {
			throw new Error("edge could not list");
		};
		await s.run();
		expect(s.edge.row.state).toBe("completed");
	});
});

describe("every product tool on a box (a real shell as the VM, the database blocked)", () => {
	async function run(tool: string, input: Record<string, unknown>) {
		const dir = mkdtempSync(join(tmpdir(), "box-tool-"));
		mkdirSync(join(dir, "repo"));
		mkdirSync(join(dir, "home"));
		mkdirSync(join(dir, "shim"));
		writeFileSync(join(dir, "shim", "sudo"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		writeFileSync(join(dir, "repo", "README.md"), "# Probe\nhello\n");
		writeFileSync(join(dir, "repo", "a.txt"), "x\n");
		const s = await scenario({
			model: [{ tool, input }, { text: "Done." }],
			shell: dir,
		});
		const ports = s.edge.state.ports as Record<string, unknown>;
		ports.subagent = async () => [];
		const receipts = new Map<string, unknown>();
		ports.commandReceipt = async (args: {
			op: string;
			requestId?: string;
			response?: { id: string };
		}) => {
			if (args.op === "claim") {
				const done = receipts.get(args.requestId ?? "");
				return done ? { kind: "done", response: done } : { kind: "claimed" };
			}
			if (args.op === "complete" && args.response)
				receipts.set(args.response.id, args.response);
			if (args.op === "retained") return [];
			return null;
		};
		ports.canvasRevision = async () => 0;
		const remote: string[] = [];
		ports.remoteTool = async (args: { tool: string }) => {
			remote.push(args.tool);
			return { ok: true };
		};
		const bodies: string[] = [];
		const deps = s.edge.deps as unknown as {
			upstream: (request: unknown, init?: RequestInit) => Promise<unknown>;
		};
		const upstream = deps.upstream;
		deps.upstream = async (request: unknown, init?: RequestInit) => {
			const copy = new Request(request as RequestInfo, init);
			bodies.push(await copy.clone().text());
			return upstream(copy);
		};
		await s.run();
		const call = (
			s.edge.row.items as { kind: string; tool?: string; output?: string }[]
		).find((item) => item.kind === "dynamicToolCall" && item.tool === tool);
		return { s, dir, call, remote, bodies, receipts };
	}

	it("offers exactly these tools (a new one needs a box check here)", async () => {
		const { bodies } = await run("read", { path: "README.md" });
		const offered = (
			JSON.parse(bodies[0] ?? "{}").tools as { function: { name: string } }[]
		).map((entry) => entry.function.name);
		expect(offered.sort()).toEqual(
			[
				"read",
				"write",
				"edit",
				"bash",
				"agent",
				"agent_send",
				"request_project_secret",
				"ask_user",
				"request_push_approval",
				"web_fetch",
				"canvas",
				"save_project_environment",
				"save_project_secret",
				"describe_secret",
				"update_plan",
				"goal",
				"run_code",
			].sort(),
		);
	}, 60_000);

	it("reads, writes and edits files on the VM, with receipts at the edge", async () => {
		const read = await run("read", { path: "README.md" });
		expect(read.call?.output).toContain("hello");
		const write = await run("write", { path: "a.txt", content: "new\n" });
		expect(write.call?.output).toContain("Overwrote");
		expect(readFileSync(join(write.dir, "repo", "a.txt"), "utf8")).toBe(
			"new\n",
		);
		expect(write.receipts.size).toBe(1);
		const edit = await run("edit", {
			path: "a.txt",
			edits: [{ old_string: "x", new_string: "y" }],
		});
		expect(edit.call?.output).toContain("1 edit applied");
		expect(readFileSync(join(edit.dir, "repo", "a.txt"), "utf8")).toBe("y\n");
		expect(dbCalls.stacks).toEqual([]);
	}, 120_000);

	it("runs code, shows a canvas, plans and asks, without the database", async () => {
		for (const [tool, input] of [
			["run_code", { code: "return 1 + 1;" }],
			["canvas", { title: "Probe", html: "<html><body>hi</body></html>" }],
			["update_plan", { plan: [{ step: "one", status: "in_progress" }] }],
			["goal", { op: "get" }],
			[
				"ask_user",
				{
					questions: [
						{ question: "Which?", options: [{ label: "A" }, { label: "B" }] },
					],
				},
			],
			[
				"request_project_secret",
				{ secrets: [{ name: "STRIPE_KEY", reason: "billing" }] },
			],
		] as [string, Record<string, unknown>][]) {
			const result = await run(tool, input);
			expect(result.s.edge.row.state, tool).toBe("completed");
			expect(dbCalls.stacks, tool).toEqual([]);
		}
	}, 180_000);

	it("sends the environment setup to the edge whole", async () => {
		const result = await run("save_project_environment", {
			install: "pnpm install",
			summary: "Installs.",
		});
		expect(result.remote).toEqual(["save_project_environment"]);
		expect(dbCalls.stacks).toEqual([]);
	}, 60_000);
});
