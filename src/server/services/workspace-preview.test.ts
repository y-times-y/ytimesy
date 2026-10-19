import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	peek: vi.fn(),
	ensure: vi.fn(),
}));
vi.mock("../config", () => ({
	serverConfig: () => ({ APP_URL: "https://app.example" }),
}));
vi.mock("./workspace-desktop", () => ({
	peekSessionMachineRef: mocks.peek,
	ensureSessionMachine: mocks.ensure,
}));

import { EDGE_AUTHORIZER_HEADER, PREVIEW_COOKIE } from "./vm-edge-auth";
import { previewHostname, sharedPreviewHostname } from "./vm-edge-keys";
import {
	listWorkspacePreviews,
	openWorkspacePreview,
	previewMachines,
	setWorkspacePreviewSharing,
} from "./workspace-preview";

const scope = { userId: "u", projectId: "p", sessionId: "s" };
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", "r".repeat(40));
	mocks.peek.mockResolvedValue("vm-s");
	mocks.ensure.mockReturnValue(Effect.succeed("vm-s"));
});

function fakeMachines(running = true) {
	return previewMachines({
		isRunning: vi.fn(async () => running),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout:
				"LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:5173 0.0.0.0:*",
			stderr: "",
		})),
		listHttpRoutes: vi.fn(async () => [
			{
				ruleId: "r1",
				domain: "ytimesy-share-abc-5173.style.dev",
				port: 5173,
				forwardAuthId: null,
			},
		]),
		publishHttpRoute: vi.fn(async (_vm, route) => ({
			origin: `https://${route.hostname}`,
			ruleId: "tls-9",
		})),
		withdrawHttpRoutes: vi.fn(async () => 1),
		ensureEdgeAuthorizer: vi.fn(async () => "fa-1"),
	} as unknown as WorkspaceMachines);
}

it("lists running apps with their share links, and never wakes a sleeping machine", async () => {
	expect(await listWorkspacePreviews(fakeMachines(), scope)).toEqual({
		status: "ready",
		ports: [
			{ port: 3000, loopbackOnly: false, shareUrl: null },
			{
				port: 5173,
				loopbackOnly: false,
				shareUrl: "https://ytimesy-share-abc-5173.style.dev",
			},
		],
	});
	const asleep = fakeMachines(false);
	expect(await listWorkspacePreviews(asleep, scope)).toEqual({
		status: "asleep",
	});
	expect(asleep.exec).not.toHaveBeenCalled();
});

it("opens a port privately: forward auth on the route and a signed sign-in link", async () => {
	const machines = fakeMachines();
	const { url } = await openWorkspacePreview(machines, scope, 3000);
	expect(machines.ensureEdgeAuthorizer).toHaveBeenCalledWith({
		url: expect.stringMatching(
			/^https:\/\/app\.example\/api\/vm-edge\/authorize\?v=/,
		),
		headers: {
			[EDGE_AUTHORIZER_HEADER]: expect.stringMatching(/^[a-f0-9]{64}$/),
		},
		protectedCookies: [PREVIEW_COOKIE],
	});
	expect(machines.publishHttpRoute).toHaveBeenCalledWith("vm-s", {
		hostname: previewHostname("vm-s", 3000),
		port: 3000,
		forwardAuthId: "fa-1",
	});
	expect(url).toMatch(
		new RegExp(
			`^https://${previewHostname("vm-s", 3000).replaceAll(".", "\\.")}/__ytimesy/preview\\?t=`,
		),
	);
});

it("shares a port on its own public name and unshares only that", async () => {
	const machines = fakeMachines();
	expect(await setWorkspacePreviewSharing(machines, scope, 3000, true)).toEqual(
		{
			shareUrl: `https://${sharedPreviewHostname("vm-s", 3000)}`,
		},
	);
	expect(machines.publishHttpRoute).toHaveBeenCalledWith("vm-s", {
		hostname: sharedPreviewHostname("vm-s", 3000),
		port: 3000,
	});
	expect(
		await setWorkspacePreviewSharing(machines, scope, 3000, false),
	).toEqual({
		shareUrl: null,
	});
	expect(machines.withdrawHttpRoutes).toHaveBeenCalledWith(
		"vm-s",
		["share"],
		3000,
	);
});

it("refuses our own service ports", async () => {
	await expect(
		openWorkspacePreview(fakeMachines(), scope, 6080),
	).rejects.toThrow("That port cannot be previewed.");
	await expect(
		setWorkspacePreviewSharing(fakeMachines(), scope, 9222, true),
	).rejects.toThrow();
});
