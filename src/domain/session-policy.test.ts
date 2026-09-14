import { describe, expect, it } from "vitest";
import { canStartAgentTurn, isAuthenticatedAgent } from "./agent-connection";
import { WorkspaceId } from "./ids";
import {
	canSendSessionTask,
	canSubmitComposer,
	canSubmitSideChat,
} from "./session-policy";
import { isUsableWorkspace } from "./workspace";

describe("agent connection", () => {
	it("treats a pending device code as unauthenticated", () => {
		const pending = {
			status: "awaiting_device_code" as const,
			provider: "codex" as const,
			loginId: "login-1",
			verificationUrl: "https://auth.openai.com/codex/device",
			userCode: "ABCD-1234",
		};

		expect(isAuthenticatedAgent(pending)).toBe(false);
		expect(canStartAgentTurn(pending)).toBe(false);
	});

	it("allows a turn only after ChatGPT authentication", () => {
		const authenticated = {
			status: "authenticated" as const,
			provider: "codex" as const,
			authMode: "chatgpt" as const,
			planType: "plus",
			email: null,
		};

		expect(isAuthenticatedAgent(authenticated)).toBe(true);
		expect(canStartAgentTurn(authenticated)).toBe(true);
	});
});

describe("session send policy", () => {
	it("requires a running workspace and an authenticated agent", () => {
		const running = {
			status: "running" as const,
			workspaceId: WorkspaceId("vm_1"),
		};
		const disconnected = { status: "disconnected" as const };

		expect(isUsableWorkspace(running)).toBe(true);
		expect(canSendSessionTask(running, disconnected)).toBe(false);
		expect(
			canSendSessionTask(running, {
				status: "authenticated",
				provider: "codex",
				authMode: "chatgpt",
				planType: null,
				email: null,
			}),
		).toBe(true);
		expect(
			canSendSessionTask(
				{ status: "creating" },
				{
					status: "authenticated",
					provider: "codex",
					authMode: "chatgpt",
					planType: null,
					email: null,
				},
			),
		).toBe(false);
	});
});

describe("composer submit policy", () => {
	it("blocks a second task while the current turn is running", () => {
		const running = {
			status: "running" as const,
			workspaceId: WorkspaceId("vm_1"),
		};
		const authenticated = {
			status: "authenticated" as const,
			provider: "codex" as const,
			authMode: "chatgpt" as const,
			planType: null,
			email: null,
		};

		expect(canSubmitComposer(running, authenticated, "idle")).toBe(true);
		expect(canSubmitComposer(running, authenticated, "running")).toBe(false);
		expect(canSubmitComposer(running, authenticated, "completed")).toBe(true);
		expect(canSubmitSideChat(running, authenticated, "idle")).toBe(true);
		expect(canSubmitSideChat(running, authenticated, "running")).toBe(false);
	});
});
