import { expect, it, vi } from "vitest";
import { recordTurnUsage } from "./usage-rollup";

const fact = {
	inputTokens: 100,
	outputTokens: 20,
	cacheReadTokens: 40,
	known: true,
};

it("counts a turn once in its day's row, with the turn's own counts", async () => {
	const query = vi.fn(async () => ({ rows: [] }));
	await recordTurnUsage("turn-1", "claude-sonnet-5-5", fact, {
		query,
	} as never);
	expect(query).toHaveBeenCalledTimes(1);
	const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
	expect(sql).toContain("insert into usage_turn_counted");
	expect(sql).toContain("on conflict do nothing");
	expect(params).toEqual([
		"turn-1",
		"anthropic",
		"claude-sonnet-5-5",
		true,
		100,
		20,
		40,
	]);
});

it("records a turn without counts as unknown, with zero tokens", async () => {
	const query = vi.fn(async () => ({ rows: [] }));
	await recordTurnUsage(
		"turn-2",
		"gpt-5.5",
		{ inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, known: false },
		{ query } as never,
	);
	const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
	expect(params).toEqual(["turn-2", "openai", "gpt-5.5", false, 0, 0, 0]);
});

it("asks the connection for a model id that names no provider", async () => {
	const query = vi
		.fn()
		.mockResolvedValueOnce({ rows: [{ provider: "google" }] })
		.mockResolvedValueOnce({ rows: [] });
	await recordTurnUsage("turn-3", "my-model", fact, { query } as never);
	expect((query.mock.calls[1] as unknown as [string, unknown[]])[1][1]).toBe(
		"google",
	);
});

it("never fails the caller when the write fails", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const query = vi.fn(async () => {
		throw new Error("connection lost");
	});
	await expect(
		recordTurnUsage("turn-4", "gpt-5.5", fact, { query } as never),
	).resolves.toBeUndefined();
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});
