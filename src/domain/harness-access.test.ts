import { describe, expect, it } from "vitest";
import { API_PROVIDER, CODEX_PROVIDER } from "./agent-provider";
import {
	canResumeDisconnectedFollowUp,
	composerCanStartSignIn,
	composerSendIsEnabled,
	harnessAccess,
	harnessLoginIsPending,
	harnessLoginShouldShow,
	harnessRequiresAccountLogin,
	selectedHarnessIsConnected,
	sendAfterConnect,
	sendReplyOutcome,
} from "./harness-access";
import { SessionItemId } from "./ids";

const codexSignedIn = {
	status: "authenticated" as const,
	provider: "codex" as const,
	authMode: "chatgpt" as const,
	planType: "pro",
	email: null,
};
const codexAwaitingCode = {
	status: "awaiting_device_code" as const,
	provider: "codex" as const,
	loginId: "ABCD-1234",
	verificationUrl: "https://auth.openai.com/codex/device",
	userCode: "ABCD-1234",
};

describe("harness access", () => {
	it("mutes an unsigned Codex row and offers sign in", () => {
		expect(
			harnessAccess(CODEX_PROVIDER, { status: "disconnected" }),
		).toMatchObject({
			readiness: "unsigned",
			muted: true,
			statusLabel: "Not signed in",
			subscriptionAction: "sign_in",
			subscriptionActionLabel: "Sign in",
		});
		expect(harnessRequiresAccountLogin("codex")).toBe(true);
		expect(harnessRequiresAccountLogin("api")).toBe(false);
	});

	it("offers ChatGPT resume when a Codex snapshot is saved", () => {
		const access = harnessAccess(
			CODEX_PROVIDER,
			{ status: "disconnected" },
			{ codexSnapshotAvailable: true },
		);
		expect(access.statusLabel).toBe("Saved workspace");
		expect(access.subscriptionActionLabel).toBe("Resume");
		expect(access.summary).toContain("saved workspace");
	});

	it("points API models at Settings until a connection exists", () => {
		expect(
			harnessAccess(API_PROVIDER, { status: "disconnected" }),
		).toMatchObject({
			readiness: "unsigned",
			statusLabel: "Not connected",
			subscriptionAction: null,
		});
	});

	it("unmutes only the provider that is actually signed in", () => {
		expect(harnessAccess(CODEX_PROVIDER, codexSignedIn)).toEqual({
			provider: CODEX_PROVIDER,
			readiness: "ready",
			muted: false,
			statusLabel: "Signed in",
			summary: "pro",
			subscriptionAction: null,
			subscriptionActionLabel: null,
			userCode: null,
			verificationUrl: null,
		});
		expect(harnessAccess(API_PROVIDER, codexSignedIn).muted).toBe(true);
		expect(selectedHarnessIsConnected(codexSignedIn, "codex")).toBe(true);
		expect(selectedHarnessIsConnected(codexSignedIn, "api")).toBe(false);
	});

	it("keeps the device code on the authorizing Codex row", () => {
		expect(harnessAccess(CODEX_PROVIDER, codexAwaitingCode)).toMatchObject({
			readiness: "authorizing",
			muted: true,
			statusLabel: "Authorizing",
			subscriptionActionLabel: "Open OpenAI",
			userCode: "ABCD-1234",
			verificationUrl: "https://auth.openai.com/codex/device",
		});
		expect(harnessLoginIsPending(codexAwaitingCode)).toBe(true);
		expect(
			harnessLoginShouldShow({
				harnessReady: false,
				harnessId: "codex",
				connection: codexAwaitingCode,
			}),
		).toBe(true);
		expect(
			harnessLoginShouldShow({
				harnessReady: false,
				harnessId: "codex",
				connection: { status: "disconnected" },
			}),
		).toBe(false);
	});

	it("lets a follow-up resume a saved Codex workspace without auto-booting", () => {
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
				harnessId: "codex",
				connection: { status: "disconnected" },
				turnStatus: "running",
				snapshotAvailable: true,
			}),
		).toBe(false);
		expect(
			canResumeDisconnectedFollowUp({
				harnessId: "api",
				connection: { status: "disconnected" },
				turnStatus: "idle",
				snapshotAvailable: true,
			}),
		).toBe(false);
	});

	it("starts a Codex sign-in from Send, but not while a code is pending", () => {
		const input = {
			harnessId: "codex" as const,
			busy: false,
			draft: "Fix the build",
			slashDraft: false,
		};
		expect(
			composerCanStartSignIn({
				...input,
				connection: { status: "disconnected" },
			}),
		).toBe(true);
		expect(
			composerCanStartSignIn({ ...input, connection: codexAwaitingCode }),
		).toBe(false);
		expect(
			composerSendIsEnabled({
				...input,
				connection: codexAwaitingCode,
				turnStatus: "idle",
				canSend: false,
				modelId: "",
			}),
		).toBe(false);
	});

	it("enables API sends only for a routed model", () => {
		const input = {
			harnessId: "api" as const,
			connection: { status: "disconnected" as const },
			turnStatus: "idle" as const,
			canSend: false,
			busy: false,
			draft: "Fix the build",
			slashDraft: false,
		};
		expect(composerSendIsEnabled({ ...input, modelId: "" })).toBe(false);
		expect(
			composerSendIsEnabled({
				...input,
				modelId: "api/00000000-0000-4000-8000-000000000000/gpt-6.1-sol",
			}),
		).toBe(true);
		// A send during a run is queued for that run, not refused.
		expect(
			composerSendIsEnabled({
				...input,
				turnStatus: "running",
				modelId: "api/00000000-0000-4000-8000-000000000000/gpt-6.1-sol",
			}),
		).toBe(true);
	});
});

describe("sending before sign-in", () => {
	it("holds the message while the device code waits, then sends", () => {
		expect(
			sendAfterConnect({
				status: "awaiting_device_code",
				provider: "codex",
				loginId: "l1",
				verificationUrl: "https://auth.openai.com/codex/device",
				userCode: "ABCD-EFGH",
			}),
		).toBe("await_sign_in");
		expect(sendAfterConnect(codexSignedIn)).toBe("send");
		expect(
			sendAfterConnect({
				status: "failed",
				provider: "codex",
				message: "Sign-in failed.",
			}),
		).toBe("abandon");
		expect(sendAfterConnect({ status: "disconnected" })).toBe("abandon");
	});
});

describe("the server's answer to a send", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const sent = {
		kind: "userMessage" as const,
		id: SessionItemId(id),
		text: "hi",
	};
	it("counts as sent only when the chat holds the message or runs a turn", () => {
		expect(
			sendReplyOutcome(
				{ connection: codexSignedIn, items: [sent], turnStatus: "running" },
				id,
			),
		).toEqual({ kind: "sent" });
		// Queued behind a run: the message is there, the turn is the old one.
		expect(
			sendReplyOutcome(
				{ connection: codexSignedIn, items: [sent], turnStatus: "idle" },
				id,
			),
		).toEqual({ kind: "sent" });
	});
	it("reports an answer with no turn behind it instead of leaving Thinking", () => {
		// The lost first send: the server answered with the chat as it was.
		expect(
			sendReplyOutcome(
				{ connection: codexSignedIn, items: [], turnStatus: "idle" },
				id,
			),
		).toEqual({
			kind: "failed",
			message: "The message didn't reach the chat. Retry.",
		});
		expect(sendReplyOutcome(undefined, id).kind).toBe("failed");
		expect(
			sendReplyOutcome(
				{
					connection: { status: "failed", provider: "codex", message: "No." },
					items: [],
					turnStatus: "idle",
				},
				id,
			),
		).toEqual({ kind: "failed", message: "No." });
	});
	it("holds the message while a device code waits", () => {
		expect(
			sendReplyOutcome(
				{
					connection: {
						status: "awaiting_device_code",
						provider: "codex",
						loginId: "l1",
						verificationUrl: "https://auth.openai.com/codex/device",
						userCode: "ABCD-EFGH",
					},
					items: [],
					turnStatus: "idle",
				},
				id,
			),
		).toEqual({ kind: "await_sign_in" });
	});
});
