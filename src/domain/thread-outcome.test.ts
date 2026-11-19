import { describe, expect, it } from "vitest";
import {
	finalReplyOf,
	readableReply,
	THREAD_REPLY_READ_LIMIT,
	threadOutcomeLines,
} from "./thread-outcome";

describe("a finished thread's outcome", () => {
	it("keeps a short reply whole", () => {
		expect(readableReply("All good.")).toEqual({ text: "All good.", cut: 0 });
	});
	it("keeps the start and the end of a long reply, where findings and verdicts are", () => {
		const reply = `START ${"x".repeat(20_000)} END-VERDICT`;
		const read = readableReply(reply);
		expect(read.cut).toBeGreaterThan(10_000);
		expect(read.text.startsWith("START")).toBe(true);
		expect(read.text.endsWith("END-VERDICT")).toBe(true);
		expect(read.text.length).toBeLessThan(THREAD_REPLY_READ_LIMIT + 200);
	});
	it("takes the marked final answer over later commentary, else the last finished message", () => {
		expect(
			finalReplyOf([
				{ kind: "agentMessage", text: "the report", phase: "final_answer" },
				{ kind: "agentMessage", text: "one more note", phase: "commentary" },
			])?.text,
		).toBe("the report");
		expect(
			finalReplyOf([
				{ kind: "agentMessage", text: "first" },
				{ kind: "agentMessage", text: "second" },
				{ kind: "agentMessage", text: "typing…", streaming: true },
			])?.text,
		).toBe("second");
		expect(finalReplyOf([])).toBeNull();
	});
	it("lists questions with their options, a proposed plan, an error and the canvases", () => {
		const lines = threadOutcomeLines({
			items: [
				{ kind: "agentMessage", text: "Done, see questions." },
				{
					kind: "userQuestion",
					questions: [
						{
							question: "Ship it?",
							options: [{ label: "Yes" }, { label: "No" }],
						},
					],
				},
				{ kind: "planProposal", text: "1. Rotate keys\n2. Publish" },
				{ kind: "error", message: "rate limited" },
			],
			canvases: [
				{
					title: "Board",
					revision: 3,
					sizeKb: 14.2,
					hasImages: true,
					description: "Board · Option A",
				},
			],
		}).join("\n");
		expect(lines).toContain(
			'- "Board" (revision 3, 14.2 KB, has images): Board · Option A',
		);
		expect(lines).toContain("Final reply:\nDone, see questions.");
		expect(lines).toContain("- Ship it? [Yes / No]");
		expect(lines).toContain("1. Rotate keys");
		expect(lines).toContain("Error: rate limited");
	});
	it("says so when there is no reply", () => {
		expect(threadOutcomeLines({ items: [], canvases: [] })).toEqual([
			"No reply yet.",
		]);
	});
});
