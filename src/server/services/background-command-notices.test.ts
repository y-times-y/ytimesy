import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { agentOutputDirectory } from "./agent-output-artifacts";
import { commandRoot } from "./api-agent-command-tools";
import {
	backgroundNoticeId,
	wakeChatsForBackgroundCommands,
	withBackgroundCommandNotices,
} from "./background-command-notices";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(
		cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** Runs guest commands on this machine, as the VM would. */
function hostMachines(running = true) {
	const exec = vi.fn(async (_vm: unknown, command: string) => {
		try {
			const output = await run("bash", ["-c", command]);
			return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
		} catch (error) {
			const failed = error as { code: number; stdout: string; stderr: string };
			return {
				exitCode: failed.code,
				stdout: failed.stdout,
				stderr: failed.stderr,
			};
		}
	});
	return {
		exec,
		isRunning: vi.fn(async () => running),
	} as unknown as WorkspaceMachines & { exec: typeof exec };
}

/** A session whose background command `id` exited with `status` (or still runs: null). */
async function session(
	commands: {
		id: string;
		status: string | null;
		notified?: "agent" | "notice";
		output?: string;
	}[],
) {
	const sessionId = crypto.randomUUID();
	const root = commandRoot(sessionId);
	const outputs = agentOutputDirectory(sessionId);
	cleanup.push(root, outputs);
	await mkdir(root, { recursive: true });
	await mkdir(outputs, { recursive: true });
	const items: SessionItem[] = [];
	for (const command of commands) {
		await writeFile(
			`${root}/${command.id}.background`,
			JSON.stringify({ label: "sleep 2; echo done", startedAt: 1_000 }),
		);
		await writeFile(`${root}/${command.id}.output`, "");
		await writeFile(
			`${outputs}/${command.id}.stdout`,
			command.output ?? "warming\ndone\n",
		);
		if (command.status !== null)
			await writeFile(`${root}/${command.id}.status`, `${command.status}\n`);
		if (command.notified)
			await writeFile(`${root}/${command.id}.notified`, command.notified);
		items.push({
			kind: "dynamicToolCall",
			id: SessionItemId(`turn:${command.id}`),
			tool: "bash",
			status: "completed",
			background: {
				id: command.id,
				label: "sleep 2; echo done",
				startedAt: 1_000,
			},
		});
	}
	return { sessionId, root, outputs, items };
}

const workspace = (machines: WorkspaceMachines) => ({
	machines,
	vm: WorkspaceId("vm"),
	cwd: "/",
});

describe("background command notices at the next step", () => {
	it("tells the agent once when its background command exits, and records it on the card", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const machines = hostMachines();
		const first = await withBackgroundCommandNotices({
			...workspace(machines),
			sessionId: chat.sessionId,
			items: chat.items,
			messages: [],
		});
		expect(first.changed).toBe(true);
		expect(first.messages).toHaveLength(1);
		expect(first.messages[0].content).toMatch(
			new RegExp(
				`^Background command ${id} \\(sleep 2; echo done\\) finished with exit 0 after \\d+[smh].*; output: ${chat.outputs}/${id}.stdout; last lines:\\nwarming\\ndone`,
			),
		);
		expect(first.items[0]).toMatchObject({ background: { exitCode: 0 } });
		expect(first.items.at(-1)).toMatchObject({
			kind: "notice",
			background: true,
			message: expect.stringContaining("sleep 2; echo done finished"),
		});
		expect(await readFile(`${chat.root}/${id}.notified`, "utf8")).toBe(
			"notice",
		);
		// The next step: already recorded and announced.
		const second = await withBackgroundCommandNotices({
			...workspace(machines),
			sessionId: chat.sessionId,
			items: first.items,
			messages: first.messages,
		});
		expect(second.changed).toBe(false);
		expect(machines.exec).toHaveBeenCalledTimes(1);
	});

	it("does not notify for commands the agent stopped or waited on, but still closes their cards", async () => {
		const stopped = crypto.randomUUID();
		const waited = crypto.randomUUID();
		const chat = await session([
			{ id: stopped, status: "130", notified: "agent" },
			{ id: waited, status: "0", notified: "agent" },
		]);
		const result = await withBackgroundCommandNotices({
			...workspace(hostMachines()),
			sessionId: chat.sessionId,
			items: chat.items,
			messages: [],
		});
		expect(result.messages).toEqual([]);
		expect(result.items).toHaveLength(2);
		expect(result.items[0]).toMatchObject({ background: { exitCode: 130 } });
		expect(result.items[1]).toMatchObject({ background: { exitCode: 0 } });
	});

	it("leaves running commands alone and costs no guest call without open background cards", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: null }]);
		const tmuxSession = `ytimesy-${id.replaceAll("-", "")}`;
		await run("tmux", [
			"-L",
			"ytimesy-api",
			"new-session",
			"-d",
			"-s",
			tmuxSession,
			"sleep 30",
		]);
		try {
			const machines = hostMachines();
			const result = await withBackgroundCommandNotices({
				...workspace(machines),
				sessionId: chat.sessionId,
				items: chat.items,
				messages: [],
			});
			expect(result.changed).toBe(false);
			const none = await withBackgroundCommandNotices({
				...workspace(machines),
				sessionId: chat.sessionId,
				items: [],
				messages: [],
			});
			expect(none.changed).toBe(false);
			expect(machines.exec).toHaveBeenCalledTimes(1);
		} finally {
			await run("tmux", [
				"-L",
				"ytimesy-api",
				"kill-session",
				"-t",
				tmuxSession,
			]).catch(() => undefined);
		}
	});

	it("at the turn's end records only exits already announced or seen, leaving new ones to wake the chat", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const result = await withBackgroundCommandNotices({
			...workspace(hostMachines()),
			sessionId: chat.sessionId,
			items: chat.items,
			messages: [],
			claim: false,
		});
		expect(result.changed).toBe(false);
		await expect(readFile(`${chat.root}/${id}.notified`)).rejects.toThrow();
	});
});

describe("waking a chat between turns", () => {
	const record = (sessionId: string, items: SessionItem[]) =>
		({
			id: sessionId,
			userId: "user",
			providerRef: "vm",
			turnStatus: "completed",
			items,
			listedModelId: "model",
			taskPlacement: null,
			agentRole: null,
		}) as unknown as AgentSessionRecord;

	it("delivers the notice like a subagent report and updates the stored cards", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "2", output: "Error: boom\n" }]);
		const machines = hostMachines();
		const notify = vi.fn(
			async (_m: unknown, _s: unknown, _id: string, _text: string) => undefined,
		);
		const replaceItems = vi.fn(async () => true);
		const woken = await wakeChatsForBackgroundCommands(machines, {
			candidates: async () => [{ userId: "user", id: chat.sessionId }],
			session: async () => record(chat.sessionId, chat.items),
			activeTurn: async () => false,
			replaceItems,
			notify,
		});
		expect(woken).toBe(1);
		expect(notify).toHaveBeenCalledWith(
			machines,
			expect.objectContaining({ id: chat.sessionId }),
			backgroundNoticeId(chat.sessionId, id),
			expect.stringContaining(
				`Background command ${id} (sleep 2; echo done) finished with exit 2`,
			),
		);
		expect(notify.mock.calls[0][3]).toContain("Error: boom");
		expect(replaceItems).toHaveBeenCalledWith(
			"user",
			chat.sessionId,
			chat.items,
			expect.arrayContaining([
				expect.objectContaining({
					background: expect.objectContaining({ exitCode: 2 }),
				}),
				expect.objectContaining({ kind: "notice", background: true }),
			]),
		);
		// Claimed once: the next tick delivers nothing again.
		notify.mockClear();
		await wakeChatsForBackgroundCommands(machines, {
			candidates: async () => [{ userId: "user", id: chat.sessionId }],
			session: async () => record(chat.sessionId, chat.items),
			activeTurn: async () => false,
			replaceItems,
			notify,
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it("skips chats whose turn runs (the turn reads it at its next step) and machines that stopped", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const notify = vi.fn(async () => undefined);
		const dependencies = {
			candidates: async () => [{ userId: "user", id: chat.sessionId }],
			session: async () => record(chat.sessionId, chat.items),
			replaceItems: async () => true,
			notify,
		};
		const busy = hostMachines();
		await wakeChatsForBackgroundCommands(busy, {
			...dependencies,
			activeTurn: async () => true,
		});
		const stopped = hostMachines(false);
		await wakeChatsForBackgroundCommands(stopped, {
			...dependencies,
			activeTurn: async () => false,
		});
		expect(busy.exec).not.toHaveBeenCalled();
		expect(stopped.exec).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});
