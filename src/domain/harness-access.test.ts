import { describe, expect, it } from "vitest";
import {
	CLAUDE_PROVIDER,
	CODEX_PROVIDER,
	OPENCODE_PROVIDER,
} from "./agent-provider";
import {
	harnessAccess,
	offeredHarnessAccess,
	selectedHarnessIsConnected,
} from "./harness-access";

describe("harness access", () => {
	it("lists every offered harness and mutes ones that are not signed in", () => {
		const rows = offeredHarnessAccess({ status: "disconnected" });
		expect(rows.map((row) => row.provider.id)).toEqual([
			"codex",
			"claude",
			"opencode",
		]);
		expect(rows.every((row) => row.muted)).toBe(true);
		expect(rows.map((row) => row.statusLabel)).toEqual([
			"Not signed in",
			"Not signed in",
			"Not signed in",
		]);
	});

	it("offers ChatGPT sign-in only on Codex", () => {
		const rows = offeredHarnessAccess({ status: "disconnected" });
		expect(rows[0]?.subscriptionAction).toBe("sign_in");
		expect(rows[0]?.subscriptionActionLabel).toBe("Sign in");
		expect(rows[1]?.subscriptionAction).toBeNull();
		expect(rows[2]?.subscriptionAction).toBeNull();
	});

	it("does not treat a saved key as a connected harness", () => {
		const claude = harnessAccess(
			CLAUDE_PROVIDER,
			{ status: "disconnected" },
			"••••xyz1",
		);
		expect(claude.muted).toBe(true);
		expect(claude.statusLabel).toBe("Key saved");
		expect(claude.summary).toContain("not connected");
		expect(
			selectedHarnessIsConnected({ status: "disconnected" }, "claude"),
		).toBe(false);
	});

	it("unmutes only the provider that is actually signed in", () => {
		const connection = {
			status: "authenticated" as const,
			provider: "codex" as const,
			authMode: "chatgpt" as const,
			planType: "pro",
			email: null,
		};
		const rows = offeredHarnessAccess(connection);
		expect(rows[0]?.muted).toBe(false);
		expect(harnessAccess(CODEX_PROVIDER, connection, null)).toEqual({
			provider: CODEX_PROVIDER,
			readiness: "ready",
			muted: false,
			statusLabel: "Signed in",
			summary: "pro",
			subscriptionAction: null,
			subscriptionActionLabel: null,
			apiKeyHint: null,
			userCode: null,
			verificationUrl: null,
		});
		expect(harnessAccess(OPENCODE_PROVIDER, connection, null).muted).toBe(true);
		expect(selectedHarnessIsConnected(connection, "codex")).toBe(true);
		expect(selectedHarnessIsConnected(connection, "claude")).toBe(false);
	});

	it("keeps the device code on the authorizing Codex row", () => {
		const access = harnessAccess(
			CODEX_PROVIDER,
			{
				status: "awaiting_device_code",
				provider: "codex",
				loginId: "login-1",
				verificationUrl: "https://auth.openai.com/codex/device",
				userCode: "ABCD-1234",
			},
			null,
		);
		expect(access).toMatchObject({
			readiness: "authorizing",
			muted: true,
			statusLabel: "Authorizing",
			subscriptionActionLabel: "Open OpenAI",
			userCode: "ABCD-1234",
			verificationUrl: "https://auth.openai.com/codex/device",
		});
	});
});
