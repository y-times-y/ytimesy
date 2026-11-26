import { describe, expect, it } from "vitest";
import {
	guardAgainstResend,
	PERSON_MESSAGE_WINDOW_MS,
	textSimilarity,
} from "./y-squared-duplicate";

const NOW = 1_000_000_000_000;
const said =
	"Please add a --verbose flag to the CLI and print debug lines to stderr";

describe("guardAgainstResend", () => {
	it("lets a send through when the person did not message the thread, or long ago", () => {
		const base = { text: said, now: NOW };
		expect(
			guardAgainstResend({ ...base, personText: null, personAt: null }).kind,
		).toBe("ok");
		expect(
			guardAgainstResend({
				...base,
				personText: said,
				personAt: NOW - PERSON_MESSAGE_WINDOW_MS - 1,
			}).kind,
		).toBe("ok");
	});

	it("refuses a reworded copy of what the person said, flag or not", () => {
		const reworded =
			"Add a --verbose flag to the CLI, printing debug lines to stderr, please.";
		const guard = guardAgainstResend({
			text: reworded,
			personText: said,
			personAt: NOW - 60_000,
			now: NOW,
			addsNewInformation: true,
			reason: "x",
		});
		expect(guard.kind).toBe("duplicate");
		expect(guard.kind === "duplicate" && guard.notice).toContain(
			"already told this thread",
		);
	});

	it("asks for addsNewInformation and a reason when the text differs", () => {
		const input = {
			text: "The CLI entry point is src/cli.ts and tests run with pnpm test",
			personText: said,
			personAt: NOW - 60_000,
			now: NOW,
		};
		const blocked = guardAgainstResend(input);
		expect(blocked.kind).toBe("needs-reason");
		expect(blocked.kind === "needs-reason" && blocked.notice).toContain(
			"--verbose flag",
		);
		expect(
			guardAgainstResend({ ...input, addsNewInformation: true }).kind,
		).toBe("needs-reason");
		expect(
			guardAgainstResend({
				...input,
				addsNewInformation: true,
				reason: "entry point",
			}).kind,
		).toBe("ok");
	});

	it("measures similarity on normalised words; a few words never count as a copy", () => {
		expect(textSimilarity("Add the FLAG!", "add the flag now")).toBe(0);
		expect(textSimilarity(said, `${said.toUpperCase()}!!`)).toBe(1);
	});
});
