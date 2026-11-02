import { describe, expect, it } from "vitest";
import { claudeCodeListedModels } from "./claude-code-route";
import {
	blockedSendAttempt,
	chatSendNeedsGithub,
	composerSendBlock,
} from "./send-blocked";

const claudeModel = claudeCodeListedModels()[0]?.id ?? "";
const keyModel = "api/3f1c2a4e-8b7d-4c1e-9f0a-1b2c3d4e5f60/openai%2Fgpt-5";

describe("composerSendBlock", () => {
	it("lets a listed API model send", () => {
		expect(
			composerSendBlock({
				harnessId: "api",
				modelId: keyModel,
				availableModelIds: [keyModel],
			}),
		).toBeNull();
	});

	it("asks for a new Claude token when the chosen Claude model's token was refused", () => {
		const block = composerSendBlock({
			harnessId: "api",
			blockers: ["no_model", "claude_token"],
			modelId: claudeModel,
			availableModelIds: [],
		});
		expect(block?.message).toBe("Claude subscription needs a new token.");
		expect(block?.action).toBe("agents");
	});

	it("names the refused token before the catalog loads", () => {
		expect(
			composerSendBlock({
				harnessId: "api",
				blockers: ["no_model", "claude_token"],
				modelId: claudeModel,
				availableModelIds: null,
			})?.kind,
		).toBe("claude_token");
	});

	it("asks for another model when the chosen one is gone but others list", () => {
		const block = composerSendBlock({
			harnessId: "api",
			blockers: ["claude_token"],
			modelId: "api/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b/openai%2Fgpt-5",
			availableModelIds: [keyModel],
		});
		expect(block?.message).toBe("Pick another model.");
		expect(block?.action).toBe("model_picker");
	});

	it("does not blame a refused Claude token when another model is chosen", () => {
		expect(
			composerSendBlock({
				harnessId: "api",
				blockers: ["claude_token"],
				modelId: keyModel,
				availableModelIds: [keyModel],
			}),
		).toBeNull();
	});

	it("asks for a model when nothing lists", () => {
		const block = composerSendBlock({
			harnessId: "api",
			blockers: ["no_model"],
			modelId: "",
			availableModelIds: [],
		});
		expect(block?.message).toBe("Add a model to send.");
		expect(block?.action).toBe("agents");
	});

	it("asks to connect GitHub when the chat needs it", () => {
		for (const harnessId of ["api", "codex"] as const) {
			const block = composerSendBlock({
				harnessId,
				blockers: ["github"],
				modelId: keyModel,
				availableModelIds: [keyModel],
			});
			expect(block?.message).toBe("Connect GitHub to send.");
			expect(block?.action).toBe("github");
		}
	});

	it("names the model first when both a model and GitHub block", () => {
		expect(
			composerSendBlock({
				harnessId: "api",
				blockers: ["no_model", "claude_token", "github"],
				modelId: claudeModel,
				availableModelIds: [],
			})?.kind,
		).toBe("claude_token");
	});

	it("leaves Codex model and sign-in states to their own UI", () => {
		expect(
			composerSendBlock({
				harnessId: "codex",
				modelId: "",
				availableModelIds: [],
			}),
		).toBeNull();
	});
});

describe("blockedSendAttempt", () => {
	const block = composerSendBlock({
		harnessId: "api",
		blockers: ["github"],
		modelId: keyModel,
		availableModelIds: [keyModel],
	});

	it("an Enter with text shows the block instead of doing nothing", () => {
		expect(blockedSendAttempt("fix the login bug", block)?.message).toBe(
			"Connect GitHub to send.",
		);
	});

	it("an empty Enter names nothing", () => {
		expect(blockedSendAttempt("  ", block)).toBeNull();
	});

	it("sends when nothing blocks", () => {
		expect(blockedSendAttempt("hi", null)).toBeNull();
	});
});

describe("chatSendNeedsGithub", () => {
	it("a new chat checks out a branch with GitHub", () => {
		expect(chatSendNeedsGithub(null)).toBe(true);
		expect(chatSendNeedsGithub({ hasConversation: false })).toBe(true);
	});

	it("a chat on its branch or a subagent does not", () => {
		expect(
			chatSendNeedsGithub({
				workingBranch: "ytimesy/x",
				hasConversation: true,
			}),
		).toBe(false);
		expect(
			chatSendNeedsGithub({ parentSessionId: "p", hasConversation: false }),
		).toBe(false);
		expect(chatSendNeedsGithub({ hasConversation: true })).toBe(false);
	});

	it("a chat whose picked branch is not checked out yet does", () => {
		expect(
			chatSendNeedsGithub({ selectedBranch: "main", hasConversation: true }),
		).toBe(true);
	});
});
