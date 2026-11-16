import { describe, expect, it, vi } from "vitest";

vi.mock("./database", () => ({
	database: () => ({ query: async () => ({ rows: [], rowCount: 1 }) }),
}));

const { BUILD_OUTPUT_NOTE_MS, databaseBuildSteps } = await import(
	"./environment-build-steps"
);

describe("databaseBuildSteps tells the page what changed", () => {
	it("on every start and finish, on output at most every 10 s", async () => {
		let now = 1_000;
		const changed = vi.fn();
		const steps = databaseBuildSteps("b", changed, () => now);
		await steps.start("install", "Install");
		await steps.output("install", "a");
		await steps.output("install", "ab");
		now += BUILD_OUTPUT_NOTE_MS - 1;
		await steps.output("install", "abc");
		now += 1;
		await steps.output("install", "abcd");
		await steps.finish("install", "done");
		// start, first output, output after 10 s, finish
		expect(changed).toHaveBeenCalledTimes(4);
	});
});
