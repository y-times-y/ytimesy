import { expect, it, vi } from "vitest";

vi.mock("../auth/auth", () => ({ requireUser: vi.fn() }));
vi.mock("../adapters/projects", () => ({ projectForOwner: vi.fn() }));
vi.mock("../adapters/freestyle/live", () => ({
	FreestyleWorkspaceMachinesLive: {},
}));
vi.mock("../services/capabilities", () => ({ WorkspaceMachineService: {} }));
vi.mock("../services/workspace-desktop", () => ({
	resolveDesktopRemote: vi.fn(),
}));

import { desktopFailureMessage } from "./desktop-session";

it("tells the viewer the desktop is still starting instead of the runtime's abort text", () => {
	for (const cause of [
		new DOMException("The operation was aborted", "AbortError"),
		new DOMException(
			"The operation was aborted due to timeout",
			"TimeoutError",
		),
		new Error("The operation was aborted"),
	])
		expect(desktopFailureMessage(cause)).toBe(
			"The desktop is still starting. Reconnect in a moment.",
		);
});

it("keeps other reasons and the sign-in message", () => {
	expect(
		desktopFailureMessage(new Response(null, { status: 401, statusText: "x" })),
	).toBe("Sign in required.");
	expect(desktopFailureMessage(new Error("Desktop is not ready."))).toBe(
		"Desktop is not ready.",
	);
});
