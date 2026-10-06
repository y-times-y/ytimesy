import { expect, it, vi } from "vitest";
import { readEvaluationSnapshot } from "../benchmarks/evaluation/read-snapshot";

it("re-observes after a terminated connection without changing the result", async () => {
	const read = vi
		.fn()
		.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
		.mockResolvedValue({ settled: false });
	expect(await readEvaluationSnapshot(read)).toEqual({ settled: false });
	expect(read).toHaveBeenCalledTimes(2);
});

it("bounds transient retries and preserves the original failure", async () => {
	const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
	const read = vi.fn().mockRejectedValue(error);
	await expect(readEvaluationSnapshot(read)).rejects.toBe(error);
	expect(read).toHaveBeenCalledTimes(3);
});

it("does not retry application or authorization failures", async () => {
	const error = new Error("Evaluation root disappeared.");
	const read = vi.fn().mockRejectedValue(error);
	await expect(readEvaluationSnapshot(read)).rejects.toBe(error);
	expect(read).toHaveBeenCalledTimes(1);
});
