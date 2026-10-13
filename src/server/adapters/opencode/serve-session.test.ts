import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import {
	abortedOpenCodeTurn,
	abortOpenCodeTurn,
	dropCopiedOpenCodeTranscript,
	OPENCODE_LOCATE_BIN_SCRIPT,
	OPENCODE_START_SERVE_SCRIPT,
	parseCurlHttp,
	parseOpenCodeAuthStatus,
} from "./serve-session";

describe("parseOpenCodeAuthStatus", () => {
	it("treats a healthy server as connected without a login", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "local",
					models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
				}),
			),
		).toMatchObject({
			stage: "authenticated",
			authMode: "local",
			models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
		});
		expect(parseOpenCodeAuthStatus(null)).toEqual({ stage: "missing" });
	});

	it("keeps working-tree file edits when reconnecting from the status file", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "local",
					turnStatus: "idle",
					items: [
						{
							kind: "userMessage",
							id: "user-1",
							text: "write the proof",
						},
						{
							kind: "fileChange",
							id: "opencode-working-tree",
							status: "completed",
							changes: [
								{
									path: "FOLLOWUP_RESUME.md",
									change: "add",
									additions: 1,
									deletions: 0,
									preview: "follow-up woke this paused VM",
								},
							],
						},
					],
				}),
			),
		).toMatchObject({
			stage: "authenticated",
			items: [
				{
					kind: "userMessage",
					id: "user-1",
					text: "write the proof",
				},
				{
					kind: "fileChange",
					id: "opencode-working-tree",
					status: "completed",
					changes: [
						{
							path: "FOLLOWUP_RESUME.md",
							change: "add",
							additions: 1,
							deletions: 0,
							preview: "follow-up woke this paused VM",
						},
					],
				},
			],
		});
	});

	it("keeps live reasoning and tool calls when reconnecting from the status file", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "authenticated",
					authMode: "local",
					turnStatus: "running",
					items: [
						{
							kind: "reasoning",
							id: "r1",
							summaries: ["inspect the timeline"],
						},
						{
							kind: "dynamicToolCall",
							id: "t1",
							tool: "read session-timeline.tsx",
							status: "inProgress",
						},
						{
							kind: "commandExecution",
							id: "c1",
							command: "pnpm test",
							cwd: "/home/ubuntu/ytimesy",
							status: "inProgress",
							output: null,
							exitCode: null,
						},
					],
				}),
			),
		).toMatchObject({
			stage: "authenticated",
			items: [
				{
					kind: "reasoning",
					summaries: ["inspect the timeline"],
				},
				{
					kind: "dynamicToolCall",
					tool: "read session-timeline.tsx",
					status: "inProgress",
				},
				{
					kind: "commandExecution",
					command: "pnpm test",
					status: "inProgress",
				},
			],
		});
	});

	it("does not keep a Zen login wait state", () => {
		expect(
			parseOpenCodeAuthStatus(
				JSON.stringify({
					stage: "awaiting_device_code",
					loginId: "opencode-zen",
					verificationUrl: "https://opencode.ai/auth",
				}),
			),
		).toEqual({ stage: "missing" });
	});
});

describe("dropCopiedOpenCodeTranscript", () => {
	it("keeps working-tree changes and drops the copied chat", () => {
		expect(
			dropCopiedOpenCodeTranscript({
				stage: "authenticated",
				authMode: "local",
				planType: null,
				models: [
					{
						id: "opencode/muse-spark-1.3-contributor-free",
						label: "Muse Spark",
					},
				],
				turnStatus: "completed",
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("user-1"),
						text: "DIFF_PROOF ping",
					},
					{
						kind: "agentMessage",
						id: SessionItemId("agent-1"),
						text: "pong",
					},
					{
						kind: "fileChange",
						id: SessionItemId("opencode-working-tree"),
						status: "completed",
						changes: [
							{
								path: "DIFF_PROOF.md",
								change: "add",
								additions: 1,
								deletions: 0,
								preview: "pong",
							},
						],
					},
				],
				serveSessionId: "ses_copied",
				seenBusy: true,
				turnStartedAt: 1,
				lastBusyAt: 1,
			}),
		).toEqual({
			stage: "authenticated",
			authMode: "local",
			planType: null,
			models: [
				{
					id: "opencode/muse-spark-1.3-contributor-free",
					label: "Muse Spark",
				},
			],
			turnStatus: "idle",
			items: [
				{
					kind: "fileChange",
					id: SessionItemId("opencode-working-tree"),
					status: "completed",
					changes: [
						{
							path: "DIFF_PROOF.md",
							change: "add",
							additions: 1,
							deletions: 0,
							preview: "pong",
						},
					],
				},
			],
			serveSessionId: null,
			seenBusy: false,
			turnStartedAt: null,
			lastBusyAt: null,
		});
	});

	it("leaves a missing or failed connect unchanged", () => {
		expect(dropCopiedOpenCodeTranscript({ stage: "missing" })).toEqual({
			stage: "missing",
		});
		expect(
			dropCopiedOpenCodeTranscript({
				stage: "failed",
				message: "opencode serve did not become healthy",
			}),
		).toEqual({
			stage: "failed",
			message: "opencode serve did not become healthy",
		});
	});
});

describe("OPENCODE_START_SERVE_SCRIPT", () => {
	it("starts serve from the project checkout", () => {
		expect(OPENCODE_START_SERVE_SCRIPT).toContain(PROJECT_CWD_PATH);
		expect(OPENCODE_START_SERVE_SCRIPT).toContain('cd "$SERVE_CWD"');
		expect(OPENCODE_START_SERVE_SCRIPT).toContain(".ytimesy-agent-secrets.env");
		expect(OPENCODE_START_SERVE_SCRIPT).toContain(
			"OPENCODE_DISABLE_AUTOUPDATE",
		);
	});
});

describe("OPENCODE_LOCATE_BIN_SCRIPT", () => {
	it("finds a snapshot OpenCode binary without installing", () => {
		expect(OPENCODE_LOCATE_BIN_SCRIPT).toContain("command -v opencode");
		expect(OPENCODE_LOCATE_BIN_SCRIPT).not.toContain("curl");
		expect(OPENCODE_LOCATE_BIN_SCRIPT).not.toContain("--version");
	});
});

describe("parseCurlHttp", () => {
	it("keeps JSON bodies when the status is not 2xx", () => {
		expect(
			parseCurlHttp('{"error":{"message":"Zen quota exceeded"}}\n429'),
		).toEqual({
			status: 429,
			body: { error: { message: "Zen quota exceeded" } },
			raw: '{"error":{"message":"Zen quota exceeded"}}',
		});
	});
});

describe("abortedOpenCodeTurn", () => {
	it("returns the composer to idle without a provider error", () => {
		expect(
			abortedOpenCodeTurn({
				stage: "authenticated",
				authMode: "local",
				planType: null,
				models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
				turnStatus: "running",
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("user-1"),
						text: "Write STOP_PROOF.md",
					},
				],
				serveSessionId: "ses_running",
				seenBusy: true,
				turnStartedAt: 1,
				lastBusyAt: 2,
			}),
		).toMatchObject({
			turnStatus: "idle",
			serveSessionId: "ses_running",
			seenBusy: false,
			turnStartedAt: null,
			lastBusyAt: null,
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "Write STOP_PROOF.md",
				},
			],
		});
	});
});

const runningOpenCodeStatus = JSON.stringify({
	stage: "authenticated",
	authMode: "local",
	planType: null,
	models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
	turnStatus: "running",
	items: [
		{
			kind: "userMessage",
			id: "user-1",
			text: "Write STOP_PROOF.md",
		},
	],
	serveSessionId: "ses_running",
	seenBusy: true,
	turnStartedAt: 1,
	lastBusyAt: 2,
});

function mockOpenCodeMachines(abortStdout: string) {
	const writes: string[] = [];
	const execs: string[] = [];
	const machines = {
		readTextFile: async () => runningOpenCodeStatus,
		writeTextFile: async (
			_workspaceId: unknown,
			_path: string,
			contents: string,
		) => {
			writes.push(contents);
		},
		exec: async (_workspaceId: unknown, command: string) => {
			execs.push(command);
			return { exitCode: 0, stdout: abortStdout, stderr: "" };
		},
	} as unknown as WorkspaceMachines;
	return { machines, writes, execs };
}

describe("abortOpenCodeTurn", () => {
	it("posts official abort and returns the composer to idle", async () => {
		const { machines, writes, execs } = mockOpenCodeMachines("true\n200");
		const stopped = await Effect.runPromise(
			abortOpenCodeTurn(machines, WorkspaceId("vm-stop")),
		);
		expect(
			execs.some((command) => command.includes("/session/ses_running/abort")),
		).toBe(true);
		expect(stopped).toMatchObject({
			stage: "authenticated",
			turnStatus: "idle",
			serveSessionId: "ses_running",
		});
		expect(stopped.stage === "authenticated" ? stopped.items : []).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "error" })]),
		);
		expect(writes.at(-1)).toContain('"turnStatus":"idle"');
	});

	it("fails the turn only when abort itself fails", async () => {
		const { machines } = mockOpenCodeMachines(
			'{"error":{"message":"session is not abortable"}}\n500',
		);
		const failed = await Effect.runPromise(
			abortOpenCodeTurn(machines, WorkspaceId("vm-stop")),
		);
		expect(failed).toMatchObject({
			stage: "authenticated",
			turnStatus: "failed",
		});
		expect(failed.stage === "authenticated" ? failed.items : []).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "error",
					message: "session is not abortable",
				}),
			]),
		);
	});
});
