import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { desktopHostname } from "#/domain/workspace-desktop";
import {
	apiAgentBrowserTools,
	safeBrowserUrl,
} from "./api-agent-browser-tools";
import type { WorkspaceMachines } from "./workspace-machines";

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
	expect(exposeHttp).toHaveBeenCalledWith(vm, 6080, desktopHostname(vm));
});
