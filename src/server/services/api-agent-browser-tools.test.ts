import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { DESKTOP_PRIVATE_READY } from "#/server/adapters/freestyle/start-desktop";
import {
	apiAgentBrowserTools,
	safeBrowserUrl,
} from "./api-agent-browser-tools";
import { desktopEdgeHostname } from "./vm-edge-keys";
import type { WorkspaceMachines } from "./workspace-machines";

vi.stubEnv("BETTER_AUTH_SECRET", "test-root-secret-that-is-long-enough-000");

it("allows loopback preview pages", async () => {
	expect(await safeBrowserUrl("http://localhost:3000/preview")).toBe(
		"http://localhost:3000/preview",
	);
});

it("rejects unsafe schemes, credentials, and metadata addresses", async () => {
	await expect(safeBrowserUrl("file:///etc/passwd")).rejects.toThrow();
	await expect(
		safeBrowserUrl("https://user:pass@example.com/"),
	).rejects.toThrow();
	await expect(
		safeBrowserUrl("http://169.254.169.254/latest/meta-data/"),
	).rejects.toThrow();
	await expect(safeBrowserUrl("http://10.0.0.1/")).rejects.toThrow();
});

it("exposes the Desktop tab viewer once when the agent starts the desktop itself", async () => {
	const vm = WorkspaceId("vm-agent");
	const exec = vi.fn(async (_vm: WorkspaceId, command: string) =>
		command.includes("scrot")
			? { exitCode: 0, stdout: "iVBORw0KGgo=", stderr: "" }
			: command.includes(DESKTOP_PRIVATE_READY)
				? { exitCode: 0, stdout: DESKTOP_PRIVATE_READY, stderr: "" }
				: { exitCode: 0, stdout: "LISTEN 0 5 127.0.0.1:6080", stderr: "" },
	);
	const exposeHttp = vi.fn(async () => "https://viewer");
	const machines = {
		exec,
		writeTextFile: vi.fn(async () => {}),
		exposeHttp,
	} as unknown as WorkspaceMachines;
	const tools = apiAgentBrowserTools({
		machines,
		vm,
		cwd: "/home/ubuntu/app",
		readOnly: false,
		signal: new AbortController().signal,
		once: (_id, run) => run(),
	});
	const screenshot = tools.browser_screenshot.execute as (
		input: object,
		options: object,
	) => Promise<{ base64: string }>;
	expect(await screenshot({}, { toolCallId: "a", messages: [] })).toEqual({
		base64: "iVBORw0KGgo=",
	});
	await screenshot({}, { toolCallId: "b", messages: [] });
	expect(exposeHttp).toHaveBeenCalledOnce();
	expect(exposeHttp).toHaveBeenCalledWith(vm, 6080, desktopEdgeHostname(vm));
});

it("says why the shared desktop could not start", async () => {
	const machines = {
		exec: vi.fn(async (_vm: WorkspaceId, command: string) =>
			command.includes(DESKTOP_PRIVATE_READY)
				? { exitCode: 0, stdout: DESKTOP_PRIVATE_READY, stderr: "" }
				: {
						exitCode: 100,
						stdout: "",
						stderr: "E: Could not get lock /var/lib/dpkg/lock-frontend",
					},
		),
		writeTextFile: vi.fn(async () => {}),
		exposeHttp: vi.fn(async () => "https://viewer"),
	} as unknown as WorkspaceMachines;
	const tools = apiAgentBrowserTools({
		machines,
		vm: WorkspaceId("vm-agent"),
		cwd: "/home/ubuntu/app",
		readOnly: false,
		signal: new AbortController().signal,
		once: (_id, run) => run(),
	});
	await expect(
		(
			tools.browser_screenshot.execute as (
				i: object,
				o: object,
			) => Promise<unknown>
		)({}, { toolCallId: "a", messages: [] }),
	).rejects.toThrow(/could not start \(exit 100\)\. E: Could not get lock/);
});
