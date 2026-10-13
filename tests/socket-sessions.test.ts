import { afterEach, expect, it, vi } from "vitest";
import type { ClientSocket } from "../src/server/sockets/client-socket";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	project: vi.fn(),
	terminal: vi.fn(),
	desktop: vi.fn(),
}));
vi.mock("../src/server/auth/auth", () => ({ requireUser: mocks.user }));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: mocks.project,
}));
vi.mock("../src/server/services/workspace-terminal", () => ({
	connectWorkspaceTerminal: mocks.terminal,
}));
vi.mock("../src/server/services/workspace-desktop", () => ({
	resolveDesktopRemote: mocks.desktop,
}));

import { runDesktopSession } from "../src/server/sockets/desktop-session";
import { runTerminalSession } from "../src/server/sockets/terminal-session";

function fakeSocket() {
	const sent: (string | Uint8Array)[] = [];
	const listeners: {
		message?: (d: string | Uint8Array, b: boolean) => void;
		close?: () => void;
	} = {};
	const socket: ClientSocket & {
		sent: typeof sent;
		closed: unknown[];
		emit: typeof listeners;
	} = {
		open: true,
		sent,
		closed: [],
		emit: listeners,
		send: (data) => sent.push(data),
		close(code, reason) {
			this.closed.push([code, reason]);
		},
		onMessage: (listener) => {
			listeners.message = listener;
		},
		onClose: (listener) => {
			listeners.close = listener;
		},
	};
	return socket;
}
const url = (path: string, query: string) =>
	new URL(`http://x${path}?${query}`);
afterEach(() => vi.resetAllMocks());

it("relays terminal input, resize controls and output, and detaches on close", async () => {
	mocks.user.mockResolvedValue({ id: "u" });
	mocks.project.mockResolvedValue({ fullName: "org/repo" });
	const pty = { write: vi.fn(), resize: vi.fn(), detach: vi.fn() };
	mocks.terminal.mockImplementation(async (input) => {
		input.onData("hello");
		return pty;
	});
	const socket = fakeSocket();
	await runTerminalSession(
		socket,
		new Headers(),
		url("/api/terminal", "projectId=p&cols=100&rows=30"),
	);
	expect(socket.sent).toEqual(["hello"]);
	socket.emit.message?.(
		JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
		false,
	);
	socket.emit.message?.("ls\n", false);
	socket.emit.message?.(new Uint8Array([3]), true);
	expect(pty.write).toHaveBeenCalledWith("ls\n");
	expect(pty.write).toHaveBeenCalledWith(new Uint8Array([3]));
	socket.emit.close?.();
	expect(pty.detach).toHaveBeenCalled();
});

it("reports sign-in and project errors to the terminal without opening a PTY", async () => {
	mocks.user.mockRejectedValue(new Response("", { status: 401 }));
	const socket = fakeSocket();
	await runTerminalSession(
		socket,
		new Headers(),
		url("/api/terminal", "projectId=p"),
	);
	expect(socket.sent[0]).toContain("Sign in required.");
	expect(mocks.terminal).not.toHaveBeenCalled();
});

it("pipes the desktop both ways, trying the websockify path when the origin refuses", async () => {
	mocks.user.mockResolvedValue({ id: "u" });
	mocks.project.mockResolvedValue({ fullName: "org/repo" });
	mocks.desktop.mockResolvedValue("https://vm.example");
	const remote = fakeSocket();
	const openRemote = vi
		.fn()
		.mockRejectedValueOnce(new Error("no"))
		.mockResolvedValueOnce(remote);
	const client = fakeSocket();
	await runDesktopSession(
		client,
		new Headers(),
		url("/api/desktop", "projectId=p"),
		openRemote,
	);
	expect(openRemote.mock.calls.map((call) => call[0])).toEqual([
		"wss://vm.example",
		"wss://vm.example/websockify",
	]);
	client.emit.message?.(new Uint8Array([1]), true);
	remote.emit.message?.(new Uint8Array([2]), true);
	expect(remote.sent).toEqual([new Uint8Array([1])]);
	expect(client.sent).toEqual([new Uint8Array([2])]);
	remote.emit.close?.();
	expect(client.closed.length).toBe(1);
});
