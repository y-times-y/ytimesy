import { describe, expect, it } from "vitest";
import {
	CLAUDE_PROVIDER,
	CODEX_PROVIDER,
	OPENCODE_PROVIDER,
} from "./agent-provider";
import {
	canResumeDisconnectedFollowUp,
	claudeAuthNeedsPaste,
	composerCanStartSignIn,
	composerSendIsEnabled,
	harnessAccess,
	harnessLoginIsPending,
	harnessLoginShouldShow,
	harnessRequiresAccountLogin,
	offeredHarnessAccess,
	runningTurnShouldPoll,
	selectedHarnessIsConnected,
	shouldAutoResumeHarnessSession,
} from "./harness-access";

describe("harness access", () => {
	it("lists every offered harness and mutes account logins that are not signed in", () => {
		const rows = offeredHarnessAccess({ status: "disconnected" });
		expect(rows.map((row) => row.provider.id)).toEqual(["codex", "claude"]);
		expect(rows.map((row) => row.muted)).toEqual([true, true]);
		expect(rows.map((row) => row.statusLabel)).toEqual([
			"Not signed in",
			"Not signed in",
		]);
	});

	it("offers ChatGPT resume when a Codex snapshot is saved", () => {
		const rows = offeredHarnessAccess(
			{ status: "disconnected" },
			{},
			{ codexSnapshotAvailable: true },
		);
		expect(rows[0]?.statusLabel).toBe("Saved workspace");
		expect(rows[0]?.subscriptionActionLabel).toBe("Resume");
		expect(rows[0]?.summary).toContain("saved workspace");
	});

	it("keeps OpenCode selectable without an account login", () => {
		expect(
			harnessAccess(OPENCODE_PROVIDER, { status: "disconnected" }, null),
		).toMatchObject({
			readiness: "unsigned",
			muted: false,
			statusLabel: "Not connected",
			subscriptionAction: "connect",
		});
	});

	it("offers sign in on Codex and Claude", () => {
		const rows = offeredHarnessAccess({ status: "disconnected" });
		expect(rows.map((row) => row.subscriptionAction)).toEqual([
			"sign_in",
			"sign_in",
		]);
		expect(rows.map((row) => row.subscriptionActionLabel)).toEqual([
			"Sign in",
			"Sign in",
		]);
		expect(harnessRequiresAccountLogin("opencode")).toBe(false);
		expect(harnessRequiresAccountLogin("claude")).toBe(true);
	});

	it("does not treat a saved key as a connected harness", () => {
		const claude = harnessAccess(
			CLAUDE_PROVIDER,
			{ status: "disconnected" },
			"••••xyz1",
		);
		expect(claude.muted).toBe(true);
		expect(claude.statusLabel).toBe("Key saved");
		expect(claude.summary).toContain("stored");
		expect(claude.subscriptionAction).toBe("sign_in");
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
		expect(harnessAccess(OPENCODE_PROVIDER, connection, null).muted).toBe(
			false,
		);
		expect(selectedHarnessIsConnected(connection, "codex")).toBe(true);
		expect(selectedHarnessIsConnected(connection, "claude")).toBe(false);
	});

	it("unmutes OpenCode as connected without a login", () => {
		const connection = {
			status: "authenticated" as const,
			provider: "opencode" as const,
			authMode: "local" as const,
			planType: null,
			email: null,
		};
		expect(harnessAccess(OPENCODE_PROVIDER, connection, null)).toMatchObject({
			readiness: "ready",
			muted: false,
			statusLabel: "Connected",
			summary: "Running on this workspace",
			subscriptionAction: null,
		});
		expect(selectedHarnessIsConnected(connection, "opencode")).toBe(true);
	});

	it("does not Connect on select even if the last view was authenticated", () => {
		expect(
			shouldAutoResumeHarnessSession({
				harnessId: "opencode",
				connection: { status: "disconnected" },
			}),
		).toBe(false);
		expect(
			shouldAutoResumeHarnessSession({
				harnessId: "codex",
				connection: { status: "disconnected" },
			}),
		).toBe(false);
		expect(
			shouldAutoResumeHarnessSession({
				harnessId: "opencode",
				connection: {
					status: "authenticated",
					provider: "opencode",
					authMode: "local",
					planType: null,
					email: null,
				},
			}),
		).toBe(false);
		expect(
			shouldAutoResumeHarnessSession({
				harnessId: "claude",
				connection: {
					status: "authenticated",
					provider: "claude",
					authMode: "subscription",
					planType: null,
					email: null,
				},
			}),
		).toBe(false);
	});

	it("lets a follow-up or side send resume OpenCode or a saved Codex workspace without auto-booting on select", () => {
		expect(
			composerCanStartSignIn({
				harnessId: "codex",
				connection: { status: "disconnected" },
				snapshotAvailable: true,
				busy: false,
				draft: "Add a follow up",
				slashDraft: false,
			}),
		).toBe(false);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "opencode",
				connection: { status: "disconnected" },
				turnStatus: "idle",
			}),
		).toBe(true);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "codex",
				connection: { status: "disconnected" },
				turnStatus: "idle",
				snapshotAvailable: true,
			}),
		).toBe(true);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "codex",
				connection: { status: "disconnected" },
				turnStatus: "idle",
			}),
		).toBe(false);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "claude",
				connection: { status: "disconnected" },
				turnStatus: "idle",
			}),
		).toBe(false);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "claude",
				connection: { status: "disconnected" },
				turnStatus: "idle",
				listedModelId: "fable",
			}),
		).toBe(true);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "opencode",
				connection: { status: "disconnected" },
				turnStatus: "running",
			}),
		).toBe(false);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "opencode",
				connection: {
					status: "failed",
					provider: "opencode",
					message: "serve failed",
				},
				turnStatus: "idle",
			}),
		).toBe(false);
	});

	it("enables Send on a disconnected OpenCode follow-up before Connect", () => {
		expect(
			composerSendIsEnabled({
				harnessId: "opencode",
				connection: { status: "disconnected" },
				turnStatus: "idle",
				canSend: false,
				busy: false,
				draft: "Add a follow up",
				modelId: "",
				slashDraft: false,
			}),
		).toBe(true);
		expect(
			composerSendIsEnabled({
				harnessId: "claude",
				connection: { status: "disconnected" },
				turnStatus: "idle",
				canSend: false,
				busy: false,
				draft: "Add a follow up",
				modelId: "",
				slashDraft: false,
			}),
		).toBe(true);
		expect(
			composerCanStartSignIn({
				harnessId: "claude",
				connection: { status: "disconnected" },
				busy: false,
				draft: "Add a follow up",
				slashDraft: false,
			}),
		).toBe(true);
		expect(
			composerSendIsEnabled({
				harnessId: "claude",
				connection: {
					status: "awaiting_device_code",
					provider: "claude",
					loginId: "claude-auth",
					verificationUrl: "https://claude.com/cai/oauth/authorize",
					userCode: "",
				},
				turnStatus: "idle",
				canSend: false,
				busy: false,
				draft: "Add a follow up",
				modelId: "",
				slashDraft: false,
			}),
		).toBe(false);
		expect(
			harnessLoginShouldShow({
				harnessReady: false,
				harnessId: "claude",
				connection: { status: "disconnected" },
			}),
		).toBe(false);
		expect(
			harnessLoginShouldShow({
				harnessReady: false,
				harnessId: "claude",
				connection: {
					status: "awaiting_device_code",
					provider: "claude",
					loginId: "claude-auth",
					verificationUrl: "https://claude.com/cai/oauth/authorize",
					userCode: "",
				},
			}),
		).toBe(true);
		expect(
			composerSendIsEnabled({
				harnessId: "opencode",
				connection: {
					status: "authenticated",
					provider: "opencode",
					authMode: "local",
					planType: null,
					email: null,
				},
				turnStatus: "idle",
				canSend: true,
				busy: false,
				draft: "Add a follow up",
				modelId: "",
				slashDraft: false,
			}),
		).toBe(false);
		expect(
			composerSendIsEnabled({
				harnessId: "opencode",
				connection: {
					status: "authenticated",
					provider: "opencode",
					authMode: "local",
					planType: null,
					email: null,
				},
				turnStatus: "idle",
				canSend: true,
				busy: false,
				draft: "Add a follow up",
				modelId: "opencode/muse-spark-1.3-contributor-free",
				slashDraft: false,
			}),
		).toBe(true);
	});

	it("keeps Anthropic's URL on the authorizing Claude row", () => {
		const access = harnessAccess(
			CLAUDE_PROVIDER,
			{
				status: "awaiting_device_code",
				provider: "claude",
				loginId: "claude-auth",
				verificationUrl:
					"https://claude.ai/oauth/authorize?code=true&client_id=abc",
				userCode: "",
			},
			null,
		);
		expect(access).toMatchObject({
			readiness: "authorizing",
			muted: true,
			subscriptionActionLabel: "Open Anthropic",
			userCode: "",
			verificationUrl:
				"https://claude.ai/oauth/authorize?code=true&client_id=abc",
		});
		expect(access.summary).toMatch(/Anthropic/);
		expect(access.summary).toMatch(/paste it here/);
		expect(
			claudeAuthNeedsPaste({
				status: "awaiting_device_code",
				provider: "claude",
				loginId: "claude-auth",
				verificationUrl:
					"https://claude.ai/oauth/authorize?code=true&client_id=abc",
				userCode: "",
			}),
		).toBe(true);
		expect(
			harnessLoginIsPending({
				status: "awaiting_device_code",
				provider: "claude",
				loginId: "claude-auth",
				verificationUrl:
					"https://claude.ai/oauth/authorize?code=true&client_id=abc",
				userCode: "",
			}),
		).toBe(true);
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
		expect(
			claudeAuthNeedsPaste({
				status: "awaiting_device_code",
				provider: "codex",
				loginId: "login-1",
				verificationUrl: "https://auth.openai.com/codex/device",
				userCode: "ABCD-1234",
			}),
		).toBe(false);
	});
});

describe("runningTurnShouldPoll", () => {
	it("polls an authenticated running turn after Send returns", () => {
		expect(
			runningTurnShouldPoll({
				turnStatus: "running",
				sideTurnStatus: "idle",
				connectionStatus: "authenticated",
				composerBusy: false,
			}),
		).toBe(true);
		expect(
			runningTurnShouldPoll({
				turnStatus: "idle",
				sideTurnStatus: "running",
				connectionStatus: "authenticated",
				composerBusy: false,
			}),
		).toBe(true);
	});

	it("keeps polling a running turn even while Send is still in flight", () => {
		expect(
			runningTurnShouldPoll({
				turnStatus: "running",
				sideTurnStatus: "idle",
				connectionStatus: "authenticated",
				composerBusy: true,
			}),
		).toBe(true);
	});

	it("keeps reconciling running turns after a disconnected view without polling idle workspaces", () => {
		expect(
			runningTurnShouldPoll({
				turnStatus: "running",
				sideTurnStatus: "idle",
				connectionStatus: "disconnected",
				composerBusy: false,
			}),
		).toBe(true);
		expect(
			runningTurnShouldPoll({
				turnStatus: "idle",
				sideTurnStatus: "running",
				connectionStatus: "disconnected",
			}),
		).toBe(true);
		expect(
			runningTurnShouldPoll({
				turnStatus: "idle",
				sideTurnStatus: "idle",
				connectionStatus: "disconnected",
			}),
		).toBe(false);
		expect(
			runningTurnShouldPoll({
				turnStatus: "completed",
				sideTurnStatus: "idle",
				connectionStatus: "authenticated",
				composerBusy: false,
			}),
		).toBe(false);
	});
});
