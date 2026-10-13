import { describe, expect, it } from "vitest";
import { canStartAgentTurn } from "./agent-connection";
import { WorkspaceId } from "./ids";
import { canSendSessionTask } from "./session-policy";
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
