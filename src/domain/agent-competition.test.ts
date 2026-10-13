import { expect, it } from "vitest";
import {
	competitionCandidateInstructions,
	competitionCandidatePublicItems,
	competitionJudgeToolAllowed,
	competitionModeAvailable,
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
