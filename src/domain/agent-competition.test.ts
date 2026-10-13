import { expect, it } from "vitest";
import {
	competitionCandidateInstructions,
	competitionCandidatePublicItems,
	competitionJudgeInstructions,
	competitionJudgeQueueText,
	competitionJudgeToolAllowed,
	competitionModeAvailable,
	competitionPublicItems,
	competitionSendIsEnabled,
	leaderCount,
} from "./agent-competition";
import { SessionItemId } from "./ids";

it("offers independent agents on new messages and follow-ups for supported runtimes", () => {
	// Held back from launch.
	expect(competitionModeAvailable({ harnessId: "codex" })).toBe(false);
	expect(competitionModeAvailable({ harnessId: "api" })).toBe(false);
	expect(leaderCount.safeParse(5).success).toBe(true);
	expect(leaderCount.safeParse(6).success).toBe(false);
});

it("shows the user's task without the candidate runtime instructions", () => {
	const items = competitionCandidatePublicItems(
		[
			{
				kind: "userMessage",
				id: SessionItemId("candidate-input"),
				text: `Add a README\n\n${competitionCandidateInstructions}`,
			},
		],
		"Add a README",
	);
	expect(items[0]).toMatchObject({ text: "Add a README" });
});

it("keeps the judge from launching or publishing agent work", () => {
	expect(competitionJudgeToolAllowed("inspect_task_diff")).toBe(true);
	expect(competitionJudgeToolAllowed("select_competition_winner")).toBe(true);
	expect(competitionJudgeToolAllowed("start_task")).toBe(false);
	expect(competitionJudgeToolAllowed("publish_task")).toBe(false);
});

it("does not send a comparison before the chat and model are ready", () => {
	const ready = {
		modeAvailable: true,
		selected: true,
		busy: false,
		turnRunning: false,
		hasSession: true,
		hasCodexAuth: true,
		harnessId: "codex" as const,
		text: "Fix the bug",
		modelId: "gpt-test",
	};
	expect(competitionSendIsEnabled(ready)).toBe(true);
	expect(competitionSendIsEnabled({ ...ready, hasSession: false })).toBe(false);
	expect(competitionSendIsEnabled({ ...ready, hasCodexAuth: false })).toBe(
		false,
	);
	expect(competitionSendIsEnabled({ ...ready, turnRunning: true })).toBe(false);
});

it("keeps judge-only instructions out of the public chat", () => {
	const originalPrompt = "Add a README";
	const visible = competitionPublicItems([
		{
			kind: "userMessage",
			id: SessionItemId("judge-input"),
			text: `Compare independent implementations for: ${originalPrompt}\n\nAgent 1: done\n\n${competitionJudgeInstructions}`,
		},
		{
			kind: "agentMessage",
			id: SessionItemId("judge-output"),
			text: "Agent 1 is stronger.",
		},
	]);
	expect(visible.map((item) => item.kind)).toEqual(["agentMessage"]);
	expect(
		competitionPublicItems([
			{
				kind: "userMessage",
				id: SessionItemId("original"),
				text: originalPrompt,
			},
			{
				kind: "userMessage",
				id: SessionItemId("status"),
				text: "Comparing agent results",
			},
			{
				kind: "userMessage",
				id: SessionItemId("judge-internal"),
				text: `Compare independent implementations for: ${originalPrompt}\n\n${competitionJudgeInstructions}`,
			},
		]),
	).toHaveLength(1);
	expect(
		competitionPublicItems([
			{
				kind: "userMessage",
				id: SessionItemId("ordinary"),
				text: "Comparing agent results",
			},
			{
				kind: "userMessage",
				id: SessionItemId("queue"),
				text: competitionJudgeQueueText,
			},
		]),
	).toMatchObject([{ id: "ordinary" }]);
});
