import { PtySession } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import FreestyleWorkerWebSocket from "../src/server/edge/freestyle-websocket";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
	const listeners = new Map<string, (event: Record<string, unknown>) => void>();
	const socket = {
		accept: vi.fn(),
		close: vi.fn(),
		send: vi.fn(),
		addEventListener: vi.fn(
			(name: string, listener: (event: Record<string, unknown>) => void) =>
				listeners.set(name, listener),
		),
	};
	const fetch = vi.fn(async () => ({ status: 101, webSocket: socket }));
	vi.stubGlobal("fetch", fetch);
	return { socket, fetch, listeners };
}

it("upgrades with headers and feeds binary output and exit events to the existing SDK", async () => {
	const { socket, fetch, listeners } = fixture();
	const transport = new FreestyleWorkerWebSocket(
		"wss://api.example.invalid/pty",
		{ headers: { Authorization: "Bearer fixture" } },
	);
	const data = vi.fn();
	const exit = vi.fn();
	new PtySession(transport, 1, { onData: data, onExit: exit });
	await new Promise<void>((resolve) => transport.on("open", resolve));
	expect(fetch).toHaveBeenCalledWith(
		new URL("https://api.example.invalid/pty"),
		expect.objectContaining({
			headers: { Authorization: "Bearer fixture", Upgrade: "websocket" },
			redirect: "manual",
		}),
	);
	expect(socket.accept).toHaveBeenCalledOnce();
	const output = new TextEncoder().encode("prepared");
	listeners.get("message")?.({ data: output.buffer });
	listeners.get("message")?.({
		data: JSON.stringify({ type: "exited", exitCode: 7 }),
	});
	expect(data).toHaveBeenCalledWith(output);
	expect(exit).toHaveBeenCalledWith(7);
	transport.send("control");
	expect(socket.send).toHaveBeenCalledWith("control");
	transport.close();
	expect(socket.close).toHaveBeenCalled();
});

it("rejects failed upgrades without leaking provider response or credentials", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ status: 401, body: { cancel: vi.fn() } })),
	);
	const transport = new FreestyleWorkerWebSocket(
		"wss://api.example.invalid/pty",
		{ headers: { Authorization: "private" } },
	);
	const error = await new Promise<Error>((resolve) =>
		transport.on("error", resolve),
	);
	expect(error.message).toBe("PTY upgrade rejected (401).");
	expect(transport.readyState).toBe(3);
});

it("closing a pending upgrade prevents a later connection from becoming live", async () => {
	const { socket } = fixture();
	const transport = new FreestyleWorkerWebSocket(
		"wss://api.example.invalid/pty",
		{ headers: {} },
	);
	transport.close();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(transport.readyState).toBe(3);
	expect(socket.close).toHaveBeenCalled();
});

it("replays fast-process frames after the SDK installs its listeners", async () => {
	const { listeners } = fixture();
	const transport = new FreestyleWorkerWebSocket(
		"wss://api.example.invalid/pty",
		{ headers: {} },
	);
	await new Promise<void>((resolve) => transport.on("open", resolve));
	listeners.get("message")?.({
		data: JSON.stringify({ type: "sessionInfo", sessionId: 17 }),
	});
	listeners.get("message")?.({
		data: new TextEncoder().encode("prepared").buffer,
	});
	listeners.get("message")?.({
		data: JSON.stringify({ type: "exited", exitCode: 0 }),
	});
	const data = vi.fn();
	const exit = vi.fn();
	const session = new PtySession(transport, -1, { onData: data, onExit: exit });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(session.sessionId).toBe(17);
	expect(data).toHaveBeenCalledOnce();
	expect(exit).toHaveBeenCalledWith(0);
});
