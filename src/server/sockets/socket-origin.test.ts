import { expect, it, vi } from "vitest";

vi.mock("../config", () => ({
	serverConfig: () => ({ APP_URL: "https://app.example" }),
}));
vi.mock("../adapters/invocation-tasks", () => ({
	trackInvocationTask: vi.fn(),
}));

import { socketOriginAllowed } from "./socket-origin";
import { handleWorkerSocket } from "./worker-sockets";

it("allows only the app's own origins", () => {
	const trusted = ["https://app.example"];
	expect(socketOriginAllowed("https://app.example", trusted)).toBe(true);
	expect(socketOriginAllowed("https://evil.example", trusted)).toBe(false);
	expect(socketOriginAllowed("null", trusted)).toBe(false);
	expect(socketOriginAllowed(null, trusted)).toBe(false);
});

it.each([
	["/api/terminal", "https://evil.example"],
	["/api/desktop", "https://evil.example"],
	["/api/desktop", null],
])(
	"refuses a %s upgrade from origin %s before opening a session",
	(path, origin) => {
		const headers = new Headers({ upgrade: "websocket" });
		if (origin) headers.set("origin", origin);
		const response = handleWorkerSocket(
			new Request(`https://app.example${path}?projectId=p`, { headers }),
		);
		expect(response?.status).toBe(403);
	},
);

it("leaves non-socket requests to the app", () => {
	expect(
		handleWorkerSocket(new Request("https://app.example/api/desktop")),
	).toBeNull();
});
