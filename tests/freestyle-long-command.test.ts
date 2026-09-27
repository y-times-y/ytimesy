import type { PtySession, PtySessionEvents } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import { runLongCommand } from "../src/server/adapters/freestyle/long-command";

afterEach(() => vi.useRealTimers());

function fixture(run: (events: PtySessionEvents) => void) {
	const session = { sessionId: 17, detach: vi.fn() } as unknown as PtySession;
	const pty = {
		open: vi.fn(async (events: PtySessionEvents) => {
			run(events);
			return session;
		}),
		close: vi.fn(async () => ({ sessionId: 17 })),
	};
	return { pty, session };
}

it("captures an exit that arrives before opening resolves and closes the guest session", async () => {
	const { pty, session } = fixture((events) => {
		events.onData?.(new TextEncoder().encode("installed"));
		events.onExit?.(0);
		events.onClose?.({ wasClean: true, code: 1000, reason: "" });
	});
	await expect(
		runLongCommand(pty, ["bash", "-c", "npm ci"], {}, 900_000),
	).resolves.toEqual({ exitCode: 0, stdout: "installed", stderr: "" });
	expect(pty.open).toHaveBeenCalledWith(
		expect.objectContaining({
			replaceOnExit: false,
			exec: expect.stringContaining("900s"),
		}),
	);
	expect(pty.close).toHaveBeenCalledWith(17);
	expect(session.detach).toHaveBeenCalled();
});

it("fails closed and kills the command when the transport drops", async () => {
	const { pty } = fixture((events) => events.onError?.(new Error("secret")));
	await expect(runLongCommand(pty, ["false"], {}, 900_000)).rejects.toThrow(
		"interrupted",
	);
	expect(pty.close).toHaveBeenCalledWith(17);
});

it("kills a stalled command at the host deadline", async () => {
	vi.useFakeTimers();
	const { pty } = fixture(() => undefined);
	const result = runLongCommand(pty, ["sleep", "9999"], {}, 900_000);
	await vi.advanceTimersByTimeAsync(915_000);
	expect((await result).exitCode).toBe(124);
	expect(pty.close).toHaveBeenCalledWith(17);
});
