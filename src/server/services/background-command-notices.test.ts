import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hasOpenBackgroundCommand,
	withBackgroundCommandExits,
} from "#/domain/background-command";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { agentOutputDirectory } from "./agent-output-artifacts";
import { commandRoot } from "./api-agent-command-tools";
import {
	backgroundNoticeId,
	wakeChatForBackgroundCommands,
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
	const metadata = (sessionId: string) =>
		({
			id: sessionId,
			userId: "user",
			providerRef: "vm",
			turnStatus: "completed",
			listedModelId: "model",
			taskPlacement: null,
			agentRole: null,
		}) as unknown as Omit<AgentSessionRecord, "items">;

	/**
	 * The watcher's dependencies over one stored chat: `applyExits` changes
	 * the stored items as the database does (withBackgroundCommandExits), and
	 * `open` hands out only the background command items. No dependency
	 * returns the whole transcript.
	 */
	const chatDependencies = (sessionId: string, items: SessionItem[]) => {
		const chat = { items };
		const applyExits = vi.fn(
			async (
				_userId: string,
				_sessionId: string,
				exits: Parameters<typeof withBackgroundCommandExits>[1],
			) => {
				const next = withBackgroundCommandExits(chat.items, exits);
				const changed = next !== chat.items;
				chat.items = next;
				return { changed, open: hasOpenBackgroundCommand(next) };
			},
		);
		return {
			chat,
			candidates: async () => [{ userId: "user", id: sessionId }],
			open: vi.fn(async () => ({
				session: metadata(sessionId),
				items: chat.items.filter(
					(item) => item.kind === "dynamicToolCall" && item.background,
				),
			})),
			metadata: vi.fn(async () => metadata(sessionId)),
			activeTurn: async () => false,
			applyExits,
			notify: vi.fn(
				async (_m: unknown, _s: unknown, _id: string, _text: string) =>
					undefined,
			),
		};
	};

	it("delivers the notice like a subagent report and records the exit in the database, never reading the transcript", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "2", output: "Error: boom\n" }]);
		const machines = hostMachines();
		const dependencies = chatDependencies(chat.sessionId, chat.items);
		const woken = await wakeChatsForBackgroundCommands(machines, dependencies);
		expect(woken).toBe(1);
		expect(dependencies.notify).toHaveBeenCalledWith(
			machines,
			metadata(chat.sessionId),
			backgroundNoticeId(chat.sessionId, id),
			expect.stringContaining(
				`Background command ${id} (sleep 2; echo done) finished with exit 2`,
			),
		);
		expect(dependencies.notify.mock.calls[0][1]).not.toHaveProperty("items");
		expect(dependencies.notify.mock.calls[0][3]).toContain("Error: boom");
		expect(dependencies.applyExits).toHaveBeenCalledWith(
			"user",
			chat.sessionId,
			[expect.objectContaining({ id, exitCode: 2, announced: true })],
		);
		expect(dependencies.chat.items).toEqual([
			expect.objectContaining({
				background: expect.objectContaining({ exitCode: 2 }),
			}),
			expect.objectContaining({ kind: "notice", background: true }),
		]);
		// Claimed once: the next tick delivers nothing again.
		dependencies.notify.mockClear();
		await wakeChatsForBackgroundCommands(machines, {
			...dependencies,
			open: async () => ({
				session: metadata(chat.sessionId),
				items: chat.items,
			}),
		});
		expect(dependencies.notify).not.toHaveBeenCalled();
	});

	it("checks chats a few at a time, not one after another, and stops starting new ones past its budget", async () => {
		const machines = hostMachines();
		let inFlight = 0;
		let peak = 0;
		const checked: string[] = [];
		const candidates = Array.from({ length: 12 }, (_, index) => ({
			userId: "user",
			id: `chat-${index}`,
		}));
		const slowOpen = async (_user: string, id: string) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			checked.push(id);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return null;
		};
		const dependencies = {
			candidates: async () => candidates,
			open: slowOpen,
			metadata: async () => null,
			activeTurn: async () => false,
			applyExits: async () => ({ changed: true, open: false }),
			notify: async () => undefined,
		};
		const started = Date.now();
		await wakeChatsForBackgroundCommands(machines, dependencies, {
			concurrency: 4,
		});
		expect(peak).toBe(4);
		expect(checked).toHaveLength(12);
		// Serial would be 12 x 20ms; four at a time is about 3 x 20ms.
		expect(Date.now() - started).toBeLessThan(200);
		// Past the budget no new chat starts; the next tick takes the rest.
		checked.length = 0;
		let clock = 0;
		await wakeChatsForBackgroundCommands(
			machines,
			{
				...dependencies,
				open: async (user: string, id: string) => {
					clock += 1_000;
					return slowOpen(user, id);
				},
			},
			{ concurrency: 2, budgetMs: 3_000, now: () => clock },
		);
		expect(checked.length).toBeLessThan(12);
		expect(checked.length).toBeGreaterThanOrEqual(2);
	});

	it("skips chats whose turn runs (the turn reads it at its next step) and machines that stopped", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const dependencies = chatDependencies(chat.sessionId, chat.items);
		const busy = hostMachines();
		await wakeChatsForBackgroundCommands(busy, {
			...dependencies,
			activeTurn: async () => true,
		});
		const stopped = hostMachines(false);
		await wakeChatsForBackgroundCommands(stopped, dependencies);
		expect(busy.exec).not.toHaveBeenCalled();
		expect(stopped.exec).not.toHaveBeenCalled();
		expect(dependencies.notify).not.toHaveBeenCalled();
		// The busy chat is left alone; the stopped machine's card closes as interrupted.
		expect(dependencies.applyExits).toHaveBeenCalledExactlyOnceWith(
			"user",
			chat.sessionId,
			[
				expect.objectContaining({
					id,
					exitCode: "interrupted",
					announced: false,
				}),
			],
		);
		expect(
			dependencies.chat.items.map((item) =>
				item.kind === "dynamicToolCall" ? item.background?.exitCode : item.kind,
			),
		).toEqual(["interrupted"]);
	});

	it("a command's exit callback wakes its chat once, even racing the cron's watcher", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const machines = hostMachines();
		const dependencies = chatDependencies(chat.sessionId, chat.items);
		const [callback, cron] = await Promise.all([
			wakeChatForBackgroundCommands(
				machines,
				{ userId: "user", id: chat.sessionId, commandId: id },
				dependencies,
			),
			wakeChatsForBackgroundCommands(machines, dependencies),
		]);
		expect(dependencies.notify).toHaveBeenCalledTimes(1);
		expect([callback === "woken", cron === 1].filter(Boolean)).toHaveLength(1);
	});

	it("a callback for a closed card costs no guest call, and waits while the chat's turn runs", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const machines = hostMachines();
		const dependencies = {
			...chatDependencies(chat.sessionId, chat.items),
			candidates: async () => [],
		};
		expect(
			await wakeChatForBackgroundCommands(
				machines,
				{ userId: "user", id: chat.sessionId, commandId: crypto.randomUUID() },
				dependencies,
			),
		).toBe("idle");
		expect(
			await wakeChatForBackgroundCommands(
				machines,
				{ userId: "user", id: chat.sessionId, commandId: id },
				{ ...dependencies, activeTurn: async () => true },
			),
		).toBe("busy");
		expect(machines.exec).not.toHaveBeenCalled();
		expect(
			await wakeChatForBackgroundCommands(
				machines,
				{ userId: "user", id: chat.sessionId, commandId: id },
				dependencies,
			),
		).toBe("woken");
		expect(dependencies.notify).toHaveBeenCalledTimes(1);
	});

	it("settles the running VM's idle timeout once the chat's last background command exited", async () => {
		const done = crypto.randomUUID();
		const still = crypto.randomUUID();
		const settleIdleTimeout = vi.fn(async () => "settled");
		// One of its commands still runs (its card stays open: a recent start
		// the machine reports nothing about): the timeout stays long.
		const busy = await session([
			{ id: done, status: "0" },
			{ id: still, status: null },
		]);
		await rm(`${busy.root}/${still}.background`);
		busy.items = busy.items.map((item) =>
			item.kind === "dynamicToolCall" && item.background?.id === still
				? { ...item, background: { ...item.background, startedAt: Date.now() } }
				: item,
		);
		expect(
			await wakeChatForBackgroundCommands(
				hostMachines(),
				{ userId: "user", id: busy.sessionId },
				{
					...chatDependencies(busy.sessionId, busy.items),
					settleIdleTimeout,
				},
			),
		).toBe("woken");
		expect(settleIdleTimeout).not.toHaveBeenCalled();
		// Its last command exited: settled (the notice is delivered first).
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: "0" }]);
		const machines = hostMachines();
		expect(
			await wakeChatForBackgroundCommands(
				machines,
				{ userId: "user", id: chat.sessionId, commandId: id },
				{
					...chatDependencies(chat.sessionId, chat.items),
					settleIdleTimeout,
				},
			),
		).toBe("woken");
		expect(settleIdleTimeout).toHaveBeenCalledExactlyOnceWith(
			machines,
			WorkspaceId("vm"),
		);
		// A stopped VM is not resumed to settle it.
		settleIdleTimeout.mockClear();
		const gone = await session([{ id: crypto.randomUUID(), status: "0" }]);
		await wakeChatForBackgroundCommands(
			hostMachines(false),
			{ userId: "user", id: gone.sessionId },
			{ ...chatDependencies(gone.sessionId, gone.items), settleIdleTimeout },
		);
		expect(settleIdleTimeout).not.toHaveBeenCalled();
	});

	it("writes and rereads nothing while nothing exits, and delivers no notice to a chat that is gone", async () => {
		const id = crypto.randomUUID();
		const chat = await session([{ id, status: null }]);
		await rm(`${chat.root}/${id}.background`);
		const dependencies = chatDependencies(
			chat.sessionId,
			chat.items.map((item) =>
				item.kind === "dynamicToolCall" && item.background
					? {
							...item,
							background: { ...item.background, startedAt: Date.now() },
						}
					: item,
			),
		);
		expect(
			await wakeChatForBackgroundCommands(
				hostMachines(),
				{ userId: "user", id: chat.sessionId },
				dependencies,
			),
		).toBe("idle");
		expect(dependencies.applyExits).not.toHaveBeenCalled();
		expect(dependencies.metadata).not.toHaveBeenCalled();
		// The chat was deleted meanwhile: no notice.
		const exited = await session([{ id: crypto.randomUUID(), status: "0" }]);
		const deleted = {
			...chatDependencies(exited.sessionId, exited.items),
			applyExits: vi.fn(async () => null),
		};
		expect(
			await wakeChatForBackgroundCommands(
				hostMachines(),
				{ userId: "user", id: exited.sessionId },
				deleted,
			),
		).toBe("idle");
		expect(deleted.notify).not.toHaveBeenCalled();
	});
});
