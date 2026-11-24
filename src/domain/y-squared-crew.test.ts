import { describe, expect, it } from "vitest";
import { crewAskLine, crewWakeBody } from "./y-squared-crew";

describe("crewAskLine", () => {
	const ask = (items: unknown[]) => crewAskLine(items as never);
	it("names the question and its options, or the secrets' names", () => {
		expect(
			ask([
				{ kind: "userMessage", id: "u", text: "go" },
				{
					kind: "userQuestion",
					id: "q",
					questions: [
						{
							question: "stderr or stdout?",
							options: [{ label: "stderr" }, { label: "stdout" }],
						},
						{ question: "second", options: [{ label: "a" }, { label: "b" }] },
					],
				},
			]),
		).toBe(
			'asks "stderr or stdout?" options: stderr / stdout (+1 more question)',
		);
		expect(
			ask([
				{
					kind: "secretRequest",
					id: "s",
					secrets: [{ name: "STAGING_API_KEY" }, { name: "DB_URL" }],
				},
			]),
		).toBe("asks for secrets STAGING_API_KEY, DB_URL");
	});
	it("is null when the person already replied or nothing is asked", () => {
		expect(
			ask([
				{ kind: "userQuestion", id: "q", questions: [] },
				{ kind: "userMessage", id: "u", text: "stderr" },
			]),
		).toBeNull();
		expect(ask([{ kind: "agentMessage", id: "a", text: "done" }])).toBeNull();
	});
	it("rides the wake line and tells Y² to ask it itself", () => {
		const body = crewWakeBody({
			events: [
				{
					kind: "waiting",
					title: "Verbose flag",
					detail: 'question; asks "stderr?" options: a / b',
				},
			],
			working: [],
			now: 0,
		});
		expect(body).toContain('asks "stderr?" options: a / b');
		expect(body).toContain("put that question to the person yourself");
	});
});
