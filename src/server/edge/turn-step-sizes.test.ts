import { afterEach, expect, it, vi } from "vitest";
import {
	logTurnStepSizes,
	STEP_HISTORY_BUDGET_BYTES,
	stepHistoryOverBudget,
} from "./turn-step-sizes";

afterEach(() => vi.restoreAllMocks());

const item = (text: string) =>
	({ kind: "userMessage", id: "a", text }) as never;

it("is over budget only above the limit", () => {
	expect(stepHistoryOverBudget(0, STEP_HISTORY_BUDGET_BYTES)).toBe(false);
	expect(stepHistoryOverBudget(1, STEP_HISTORY_BUDGET_BYTES)).toBe(true);
	expect(stepHistoryOverBudget(STEP_HISTORY_BUDGET_BYTES, 1)).toBe(true);
});

it("warns once about an oversized history read from the database, and logs sizes", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	logTurnStepSizes(
		"turn",
		{ messages: [], items: [item("x".repeat(STEP_HISTORY_BUDGET_BYTES))] },
		"database",
	);
	expect(warn).toHaveBeenCalledOnce();
	const warned = JSON.parse(String(warn.mock.calls[0][0]));
	expect(warned).toMatchObject({
		event: "turn.step_over_budget",
		turnId: "turn",
		budgetBytes: STEP_HISTORY_BUDGET_BYTES,
	});
	expect(warned.itemsBytes).toBeGreaterThan(STEP_HISTORY_BUDGET_BYTES);
	expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
		event: "turn.step_sizes",
		itemsBytes: warned.itemsBytes,
	});
});

it("counts UTF-8 bytes exactly without serializing either whole history array", () => {
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	const history = {
		messages: [{ role: "user", content: "different 🧪 漢字 \n text" }] as never,
		items: [item('emoji 🎉 and quotes " and slash \\'), item("second")],
	};
	const expected = {
		messagesBytes: Buffer.byteLength(JSON.stringify(history.messages)),
		itemsBytes: Buffer.byteLength(JSON.stringify(history.items)),
	};
	const stringify = vi.spyOn(JSON, "stringify");
	logTurnStepSizes("unicode-turn", history, "database");
	expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject(expected);
	expect(
		stringify.mock.calls.some(
			([value]) => value === history.messages || value === history.items,
		),
	).toBe(false);
});

it("stays quiet for a small history and never serializes a cached one", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	logTurnStepSizes("turn", { messages: [], items: [item("hi")] }, "database");
	logTurnStepSizes(
		"turn",
		{ messages: [], items: [item("x".repeat(STEP_HISTORY_BUDGET_BYTES))] },
		"cache",
	);
	expect(warn).not.toHaveBeenCalled();
	const cached = JSON.parse(String(info.mock.calls[1][0]));
	expect(cached.itemsBytes).toBeUndefined();
});
