import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	isSideChat,
	sessionsInSubagentTree,
	sideChatInstructions,
	sideChatModelText,
	sideChatReadOnly,
	sideChatSendTarget,
	slashCommandOpensSideChat,
} from "./side-chat";
import {
	composerSlashCommands,
	parseSlashDraft,
	slashMenuCommands,
} from "./slash-command";

const running = composerSlashCommands({
	authenticated: true,
	requiresAccountLogin: true,
	turnRunning: true,
	canSend: false,
	hasLastUserMessage: true,
	canCompact: false,
	hasModels: true,
});

describe("side chat", () => {
	it("lists /side in the command menu while Main is working", () => {
		const draft = parseSlashDraft("/");
		expect(draft).not.toBeNull();
		const menu = slashMenuCommands(
			draft ?? { query: "", argument: "" },
			running,
		);
		expect(menu.map((command) => command.trigger)).toContain("/side");
		const side = menu.find((command) => command.id === "side");
		expect(side && slashCommandOpensSideChat(side)).toBe(true);
	});

	it("sends on the side session and leaves the parent untouched", () => {
		expect(
			sideChatSendTarget({
				parentSessionId: "parent",
				sideSessionId: "side",
				sideTurnStatus: "idle",
			}),
		).toEqual({ sessionId: "side", queueOn: "none", parent: "untouched" });
		expect(
			sideChatSendTarget({
				parentSessionId: "parent",
				sideSessionId: "side",
				sideTurnStatus: "running",
			}),
		).toEqual({ sessionId: "side", queueOn: "side", parent: "untouched" });
		expect(() =>
			sideChatSendTarget({
				parentSessionId: "parent",
				sideSessionId: "parent",
				sideTurnStatus: "running",
			}),
		).toThrow(/cannot be the main chat/);
	});

	it("grounds the side turn in the main chat without addressing Main", () => {
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Fix the login bug",
			},
			{
				kind: "agentMessage",
				id: SessionItemId("agent"),
				text: "Editing auth.ts",
			},
			{
				kind: "commandExecution",
				id: SessionItemId("cmd"),
				command: "npm test",
				cwd: null,
				status: "inProgress",
				output: null,
				exitCode: null,
			},
		];
		const text = sideChatModelText("what is Main doing?", items);
		expect(text).toContain("what is Main doing?");
		expect(text).toContain("Editing auth.ts");
		expect(text).toContain("npm test");
		expect(text).toContain("must not message or stop it");
	});

	it("keeps a side chat out of the helper tree", () => {
		const sessions = [
			{ id: "root", parentSessionId: null, agentBudget: null },
			{
				id: "side",
				parentSessionId: "root",
				agentBudget: { sideChat: true as const },
			},
			{
				id: "under-side",
				parentSessionId: "side",
				agentBudget: null,
			},
			{ id: "helper", parentSessionId: "root", agentBudget: null },
		];
		expect(isSideChat(sessions[1])).toBe(true);
		expect(
			sessionsInSubagentTree("root", sessions).map((session) => session.id),
		).toEqual(["root", "helper"]);
	});
});

it("reads but never writes the checkout while Main's turn runs", () => {
	expect(sideChatReadOnly("running")).toBe(true);
	for (const status of ["idle", "completed", "failed", undefined] as const)
		expect(sideChatReadOnly(status)).toBe(false);
	expect(sideChatInstructions()).toContain(
		"While Main is working, your tools are read-only",
	);
});
