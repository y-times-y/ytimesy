import { expect, it } from "vitest";
import { SessionItemId } from "../src/domain/ids";
import { prepareInterruptedStep } from "../src/domain/interrupted-step";
import type { SessionItem } from "../src/domain/session-item";

const turn = "turn-1";
const id = (value: string) => SessionItemId(value);

it("marks unfinished calls interrupted and tells the model what already ran", () => {
	const items: SessionItem[] = [
		{
			kind: "dynamicToolCall",
			id: id("turn-0:step-1:a"),
			tool: "old",
			status: "inProgress",
		},
		{
			kind: "dynamicToolCall",
			id: id(`${turn}:step-1:a`),
			tool: "read_file",
			input: "a.ts",
			status: "completed",
		},
		{
			kind: "dynamicToolCall",
			id: id(`${turn}:step-2:b`),
			tool: "apply_patch",
			input: "b.ts",
			status: "completed",
		},
		{
			kind: "dynamicToolCall",
			id: id(`${turn}:step-2:c`),
			tool: "start_command",
			input: "npm test",
			status: "inProgress",
		},
		{
			kind: "agentMessage",
			id: id(`${turn}:step-2:t`),
			text: "Partial",
			streaming: true,
		},
	];
	const prepared = prepareInterruptedStep(
		[{ role: "user", content: "fix it" }],
		items,
		turn,
		2,
	);
	const notice = prepared.messages.at(-1)?.content as string;
	expect(notice).toContain("apply_patch b.ts (finished)");
	expect(notice).toContain("start_command npm test (outcome unknown)");
	expect(notice).not.toContain("read_file");
	// The notice names no command tool the session may not have been offered.
	expect(notice).not.toMatch(/read_command|wait_command/);
	expect(notice).toContain("resume them by id");
	expect(notice).not.toContain("old");
	expect(prepared.items[0]).toEqual(items[0]);
	expect(prepared.items[3]).toMatchObject({ status: "failed" });
	expect(prepared.items[4]).toMatchObject({ streaming: false });
});

it("says so when the interrupted step had not started any tool", () => {
	const prepared = prepareInterruptedStep([], [], turn, 1);
	expect(prepared.messages).toHaveLength(1);
	expect(prepared.messages[0].content).toContain("No tool calls had started.");
});
