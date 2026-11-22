import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCodeTurnRevision } from "../../domain/claude-code-route";
import { edgeSocketMessage } from "../../domain/turn-box-protocol";
import type { VmEnsureResponse } from "../../domain/turn-box-vm-protocol";
import type { GuestExec } from "../claude-box-tools/identity-machines";
import {
	ClaudeRelay,
	claudeRelayCallTag,
	isClaudeRelayBoxMessage,
	relayClaudeCall,
	relayedClaudeTools,
} from "../edge/claude-relay";
import { fakeEdge } from "../edge/turn-box-fake-edge";

/**
 * A Claude Code turn whose step runs on a turn runner box
 * (docs/turn-runner-boxes.md, "Claude Code on a box"): the real `runApiTurn`
 * through `runTurnRunnerBox`, the fake edge (the real routes over an
 * in-memory turn table), the chat object's real relay (claude-relay.ts) on
 * an in-memory SQLite, and a fake Claude runner box behind the edge's
 * `claude` port. The run's MCP call goes the production way: an edge request
 * held while the object relays it over the box's socket, the box running the
 * tool against the chat's VM and answering back. The box has no database.
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
import { type BoxSocket, TurnBoxEdgeClient } from "./turn-box-client";
import { boxWorkspaceMachines } from "./turn-box-vm-machines";

const CLEAN_ENV = {
	YTIMESY_EDGE_URL: "https://edge.test",
	YTIMESY_BOX_IDENTITY: "ytbi1.x.y",
	YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
	TURN_BOX_EDGE_PUBLIC_KEY: "public",
	PATH: "/usr/bin",
	HOME: "/home/box",
};
const RUNNER = "https://runner-a.test";
const HOME = "/home/runner";
const CLAUDE_SESSION = "33333333-3333-4333-8333-333333333333";

function sql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	};
}

/**
 * The Claude runner box, as the edge's signed /exec, /write and /read reach
 * it: the commands the runner sends, understood just enough. `onLaunch`
 * plays the `claude` process once a run starts.
 */
class FakeRunner {
	readonly files = new Map<string, string>();
	readonly commands: string[] = [];
	out = "";
	status: string | null = null;
	runs = "";
	onLaunch: (() => void) | null = null;

	shell = async (command: string) => {
		this.commands.push(command);
		const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
		if (command.includes('/current" 2>/dev/null')) {
			const run = this.files.get(`${this.runs}/current`) ?? "";
			if (!run) return ok(`${HOME}\n\n`);
			const consumed = this.files.has(`${this.runs}/${run}/consumed`);
			return ok(
				`${HOME}\n${run}\n${consumed ? "consumed" : "active"}\n${this.files.get(`${this.runs}/session`) ?? ""}`,
			);
		}
		for (const write of command.matchAll(
			/printf %s '([^']*)' \| base64 -d (>>?) '([^']+)'/g,
		)) {
			const [, data = "", mode, path = ""] = write;
			const text = Buffer.from(data, "base64").toString("utf8");
			this.files.set(
				path,
				mode === ">>" ? (this.files.get(path) ?? "") + text : text,
			);
		}
		if (!command.includes("setsid nohup") && command.includes("base64 -d"))
			return ok();
		if (command.includes("setsid nohup")) {
			const run = /d='([^']+)'/.exec(command)?.[1] ?? "";
			this.files.set(`${run}/started`, "1");
			this.files.set(
				`${this.runs}/current`,
				run.slice(run.lastIndexOf("/") + 1),
			);
			const launched = this.onLaunch;
			this.onLaunch = null;
			setTimeout(() => launched?.(), 0);
			return ok();
		}
		const poll = /'([^']+)' (-?\d+) (\d+)(?: [\d.]+)?$/.exec(command);
		if (command.startsWith("python3 -c") && poll) {
			const [, dir = "", commit = "-1", limit = "0"] = poll;
			// As the real script, a waiting poll waits first (briefly here) and
			// then reads: the run goes on meanwhile.
			if (Number(limit) > 0 && / [\d.]+$/.test(command))
				await new Promise((resolve) => setTimeout(resolve, 5));
			const saved = Number(this.files.get(`${dir}/offset`) ?? "0");
			if (Number(commit) > saved) this.files.set(`${dir}/offset`, commit);
			const offset = Math.max(saved, Number(commit));
			const bytes = Buffer.from(this.out, "utf8");
			const data = bytes.subarray(offset, offset + Number(limit));
			const end = data.lastIndexOf(10);
			const lines: string[] = [];
			let next = offset;
			if (end >= 0) {
				let position = offset;
				for (const raw of data
					.subarray(0, end + 1)
					.toString()
					.split("\n")
					.slice(0, -1)) {
					lines.push(`${position}\t${raw}`);
					position += Buffer.byteLength(raw) + 1;
				}
				next = offset + end + 1;
			}
			return ok(
				[
					JSON.stringify({
						offset,
						next,
						status: this.status,
						size: bytes.length,
					}),
					...lines,
				].join("\n"),
			);
		}
		if (command.startsWith("stat -c %s ")) {
			const path = /'([^']+)'/.exec(command)?.[1] ?? "";
			return ok(String(Buffer.byteLength(this.file(path))));
		}
		if (command.startsWith("test -s ")) {
			const path = /'([^']+)'/.exec(command)?.[1] ?? "";
			return { exitCode: this.file(path) ? 0 : 1, stdout: "", stderr: "" };
		}
		if (command.includes("/consumed")) {
			const dir = /: > '([^']+)\/consumed'/.exec(command)?.[1] ?? "";
			const commit = /printf '%s' (\d+) > /.exec(command)?.[1];
			if (commit) this.files.set(`${dir}/offset`, commit);
			this.files.set(`${dir}/consumed`, "");
			return ok();
		}
		const session = /printf '%s' '([^']+)' > '([^']+)'$/.exec(command);
		if (session) {
			this.files.set(session[2] ?? "", session[1] ?? "");
			return ok();
		}
		if (command.startsWith("cat -- ")) {
			const path = /'([^']+)'/.exec(command)?.[1] ?? "";
			return ok(this.file(path));
		}
		return ok();
	};

	/** A file on the runner; Claude's own session file exists once a run started. */
	file(path: string) {
		if (path.endsWith(`/${CLAUDE_SESSION}.jsonl`) && this.out)
			return '{"type":"user"}\n';
		return this.files.get(path) ?? "";
	}

	emit(...events: unknown[]) {
		this.out += events.map((event) => `${JSON.stringify(event)}\n`).join("");
	}
}

async function scenario(options: { dropSocketAfterTools?: boolean } = {}) {
	const edge = await fakeEdge();
	edge.row.messages = [{ role: "user", content: "read a.ts" }];
	edge.row.items = [
		{ kind: "userMessage", id: "m1", text: "read a.ts" } as never,
	];
	edge.row.connection_id = null;
	edge.row.connection_revision = claudeCodeTurnRevision();
	edge.row.model_id = "claude-sonnet-5-5";
	edge.queue.push({ ...edge.row });
	const turnId = edge.row.id;

	// The chat's Durable Object: its relay, the box's socket, the calls' sockets.
	const boxSockets: { send(data: string): void; close(): void }[] = [];
	const callSockets = new Map<
		string,
		{ send(data: string): void; close(): void }
	>();
	const relay = new ClaudeRelay(sql(), {
		box: () => boxSockets,
		call: (id) => {
			const socket = callSockets.get(claudeRelayCallTag(id));
			return socket ? [socket] : [];
		},
	});
	const objectMessages: string[] = [];
	let dropped = false;
	let sockets = 0;
	const boxSocket = async (): Promise<BoxSocket> => {
		sockets += 1;
		const messages: ((data: string) => void)[] = [];
		const closes: (() => void)[] = [];
		const toBox = {
			send: (data: string) =>
				queueMicrotask(() => {
					for (const handler of messages) handler(data);
				}),
			close: () => {
				for (const handler of closes) handler();
			},
		};
		boxSockets.push(toBox);
		queueMicrotask(() => relay.deliver(turnId, true));
		return {
			send: (data) => {
				objectMessages.push(data);
				const parsed = JSON.parse(data) as {
					t: string;
					seq?: number;
					definitions?: unknown[];
					ids?: string[];
					id?: string;
					reply?: { text: string; isError: boolean };
				};
				relay.deliver(turnId);
				if (isClaudeRelayBoxMessage(parsed)) {
					if (parsed.t === "claude-tools") {
						relay.tools(turnId, parsed.definitions ?? []);
						// The socket drops (a deploy, a network blip) before the call.
						if (options.dropSocketAfterTools && !dropped) {
							dropped = true;
							boxSockets.splice(boxSockets.indexOf(toBox), 1);
							queueMicrotask(() => toBox.close());
						}
					} else if (parsed.t === "claude-ack") relay.ack(parsed.ids ?? []);
					else if (parsed.reply) relay.reply(parsed.id ?? "", parsed.reply);
					return;
				}
				toBox.send(
					JSON.stringify(
						edgeSocketMessage.parse({
							t: "ack",
							seq: parsed.seq ?? 0,
							ok: true,
						}),
					),
				);
			},
			close: () => {
				boxSockets.splice(boxSockets.indexOf(toBox), 1);
			},
			onMessage: (handler) => messages.push(handler),
			onClose: (handler) => closes.push(handler),
		};
	};
	/** What the edge Worker does with the run's MCP request: hold it, relay through the object. */
	const chat = {
		fetch: async (request: Request) => {
			const id = new URL(request.url).searchParams.get("id") ?? "";
			type Listener = (event: { data?: unknown }) => void;
			const listeners = { message: [] as Listener[], close: [] as Listener[] };
			callSockets.set(claudeRelayCallTag(id), {
				send: (data) =>
					queueMicrotask(() => {
						for (const listener of listeners.message) listener({ data });
					}),
				close: () => {},
			});
			const worker = {
				accept() {},
				addEventListener(type: "message" | "close", listener: Listener) {
					listeners[type].push(listener);
				},
				send: (data: string) =>
					queueMicrotask(() => relay.call(turnId, id, JSON.parse(data))),
				close: () => {
					relay.callClosed(id);
					callSockets.delete(claudeRelayCallTag(id));
				},
			};
			return { status: 101, webSocket: worker } as unknown as Response;
		},
	};

	// The Claude runner box and the `claude` process on it.
	const runner = new FakeRunner();
	runner.runs = `${HOME}/.ytimesy/claude-runs/${turnId}`;
	const mcp: { tools: string[]; reply: unknown } = { tools: [], reply: null };
	runner.onLaunch = async () => {
		runner.emit({
			type: "system",
			subtype: "init",
			session_id: CLAUDE_SESSION,
			mcp_servers: [{ name: "ytimesy", status: "connected" }],
		});
		const listed = await relayedClaudeTools(async () =>
			relay.listedTools(turnId),
		);
		mcp.tools = listed.map((tool) => tool.name);
		const tool = "bash";
		const args = { command: "cat a.ts" };
		runner.emit({
			type: "assistant",
			message: {
				id: "msg_1",
				content: [
					{ type: "text", text: "Reading it." },
					{
						type: "tool_use",
						id: "toolu_1",
						name: `mcp__ytimesy__${tool}`,
						input: args,
					},
				],
			},
		});
		mcp.reply = await relayClaudeCall(chat, "Bearer grant", {
			name: tool,
			args,
			invocationId: "toolu_1",
			timeoutMs: 60_000,
			graceMs: 0,
		});
		runner.emit(
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							content: (mcp.reply as { text: string }).text,
						},
					],
				},
			},
			{
				type: "result",
				subtype: "success",
				is_error: false,
				result: "a.ts says ok.",
				session_id: CLAUDE_SESSION,
				usage: { input_tokens: 10, output_tokens: 20 },
			},
		);
		runner.status = "0";
	};

	const claudeCalls: { op: string }[] = [];
	const sessions: unknown[] = [];
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
		commitTurn: { publish: false },
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
	// The edge's `claude` port, over the fake runner (turn-box-claude-port.ts).
	ports.claude = async (args: {
		op: string;
		command?: string;
		path?: string;
		contents?: string;
		record?: unknown;
		baseUrl?: string;
	}) => {
		claudeCalls.push({ op: args.op });
		if (args.baseUrl !== undefined && args.baseUrl !== RUNNER)
			throw new Error("not this chat's runner");
		switch (args.op) {
			case "runner":
				return { baseUrl: RUNNER };
			case "exec":
				return runner.shell(args.command ?? "");
			case "write":
				runner.files.set(args.path ?? "", args.contents ?? "");
				return null;
			case "read":
				return { contents: runner.file(args.path ?? "") || null };
			case "disk":
				return 0.1;
			case "grant":
				return "ytcc1.grant.relay";
			case "sessionRead":
				return null;
			case "sessionSave":
				sessions.push(args.record);
				return null;
			case "transcriptUpload":
				return "prefix/claude-code-x.enc";
			case "transcriptDownload":
				return "";
			case "subscription":
				return {
					status: "connected",
					message: null,
					limitedUntil: null,
					connectedAt: 0,
				};
		}
		return null;
	};

	const vmEdge = {
		ensure: async (): Promise<VmEnsureResponse> => ({
			vm: "vm-1",
			grant: { token: "scoped-token", linuxUser: "ubuntu", redactOnVm: false },
		}),
		pause: async () => "skipped" as const,
		op: async () => ({}),
		release: async () => undefined,
	};
	// The chat's VM: a real shell in a scratch directory. Its own sudo
	// refuses, so the VM's setup never reaches the machine running the tests.
	const vmDir = mkdtempSync(join(tmpdir(), "box-claude-vm-"));
	for (const sub of ["repo", "home", "shim"]) mkdirSync(join(vmDir, sub));
	writeFileSync(join(vmDir, "shim", "sudo"), "#!/bin/sh\nexit 1\n", {
		mode: 0o755,
	});
	writeFileSync(join(vmDir, "repo", "a.ts"), "export const ok = 1;\n");
	const vmCommands: string[] = [];
	const guest: () => GuestExec = () => async (options) => {
		vmCommands.push(options.command);
		if (options.command.includes("ytimesy-project-cwd"))
			return { stdout: `${vmDir}/repo`, stderr: "", statusCode: 0 };
		const ran = spawnSync("bash", ["-c", options.command], {
			...(options.stdin ? { input: Buffer.from(options.stdin, "base64") } : {}),
			cwd: `${vmDir}/repo`,
			env: {
				PATH: `${vmDir}/shim:${process.env.PATH ?? "/usr/bin:/bin"}`,
				HOME: `${vmDir}/home`,
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		return {
			stdout: ran.stdout ?? "",
			stderr: ran.stderr ?? "",
			statusCode: ran.status ?? 1,
		};
	};

	const requests: string[] = [];
	const counted = (async (target: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(target)).pathname;
		let label = path.replace("/box/v1/", "");
		if (path.endsWith("/port") && typeof init?.body === "string")
			label = `port:${(JSON.parse(init.body) as { op: string }).op}`;
		requests.push(label);
		return edge.fetchEdge(target, init);
	}) as typeof fetch;
	const client = new TurnBoxEdgeClient({
		edgeUrl: "https://edge.test",
		identity: edge.identity,
		fetch: counted,
		now: () => edge.state.now,
		socket: boxSocket,
	});
	const run = async () => {
		const box = await runTurnRunnerBox({
			env: { ...CLEAN_ENV },
			client,
			machinesFor: () =>
				boxWorkspaceMachines({ edge: vmEdge, guest, now: () => Date.now() }),
			signalHandlers: false,
		});
		await box.dispatcher.drain();
	};
	return {
		cleanup: () => rmSync(vmDir, { recursive: true, force: true }),
		edge,
		run,
		runner,
		mcp,
		claudeCalls,
		sessions,
		requests,
		vmCommands,
		objectMessages,
		sockets: () => sockets,
	};
}

beforeEach(() => {
	dbCalls.stacks.length = 0;
	vi.restoreAllMocks();
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a Claude Code turn on a box", () => {
	it("runs Claude on its runner through the edge and answers the run's MCP call over the relay", async () => {
		const s = await scenario();
		try {
			await s.run();
		} finally {
			s.cleanup();
		}
		const items = s.edge.row.items as {
			kind: string;
			text?: string;
			message?: string;
			cause?: string;
		}[];
		const error = items.find((item) => item.kind === "error");
		expect(error, `${error?.message} | ${error?.cause}`).toBeUndefined();
		expect(s.edge.row.state).toBe("completed");
		// The box never touched a database; the edge chose, signed for and
		// pinned the runner, minted the grant and kept the Claude session.
		expect(dbCalls.stacks).toEqual([]);
		const ops = new Set(s.claudeCalls.map((call) => call.op));
		for (const op of ["runner", "grant", "exec", "subscription"])
			expect(ops, op).toContain(op);
		expect(s.sessions).toContainEqual(
			expect.objectContaining({ claudeSessionId: CLAUDE_SESSION }),
		);
		// The run listed the box's tools and its call was answered by the box.
		expect(s.mcp.tools.length).toBeGreaterThan(0);
		expect(
			s.mcp.reply,
			JSON.stringify([s.mcp.reply, s.mcp.tools]),
		).toMatchObject({ isError: false });
		expect(s.vmCommands.length).toBeGreaterThan(0);
		// The run's tool call shows in the chat, and its answer is the turn's.
		expect(items).toContainEqual(
			expect.objectContaining({ kind: "dynamicToolCall", tool: "bash" }),
		);
		expect(s.edge.row.messages.at(-1)).toEqual({
			role: "assistant",
			content: "a.ts says ok.",
		});
		// Every poll of the run waits on the runner (one request per batch or 20 s).
		const polls = s.runner.commands.filter(
			(command) =>
				command.startsWith("python3 -c") && / \d+ \d+ [\d.]+$/.test(command),
		);
		expect(polls.length).toBeGreaterThan(0);
	});

	it("hears the run's call after its socket dropped: the object keeps it until the box is back", async () => {
		const s = await scenario({ dropSocketAfterTools: true });
		try {
			await s.run();
		} finally {
			s.cleanup();
		}
		const error = (
			s.edge.row.items as { kind: string; message?: string; cause?: string }[]
		).find((item) => item.kind === "error");
		expect(error, `${error?.message} | ${error?.cause}`).toBeUndefined();
		expect(s.edge.row.state).toBe("completed");
		expect(s.sockets()).toBeGreaterThanOrEqual(2);
		expect(s.mcp.reply).toMatchObject({ isError: false });
		// Taken once, run once.
		const replies = s.objectMessages.filter((text) =>
			text.startsWith('{"t":"claude-reply"'),
		);
		expect(replies).toHaveLength(1);
	});
});
