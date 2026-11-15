import { expect, it } from "vitest";
import { replayBrowserBlock, replayRecords } from "./replay-choice";
import { replayUnavailableReason } from "./replay-choice-setting";

it("records only when allowed, unblocked and not declined", () => {
	for (const allowed of [true, false])
		for (const block of [
			null,
			"do-not-track",
			"global-privacy-control",
		] as const)
			for (const choice of [null, "allowed", "declined"] as const)
				expect(replayRecords({ allowed, block, choice })).toBe(
					allowed && block === null && choice !== "declined",
				);
});

it("reads Do Not Track and Global Privacy Control", () => {
	expect(replayBrowserBlock({ doNotTrack: "1" })).toBe("do-not-track");
	expect(
		replayBrowserBlock({ doNotTrack: null, globalPrivacyControl: true }),
	).toBe("global-privacy-control");
	expect(replayBrowserBlock({ doNotTrack: "0" })).toBeNull();
});

it("says why replay is off instead of offering a switch", () => {
	expect(replayUnavailableReason({ strict: true, block: null })).toMatch(
		/your region/,
	);
	expect(
		replayUnavailableReason({ strict: false, block: "do-not-track" }),
	).toMatch(/Do Not Track/);
	expect(
		replayUnavailableReason({
			strict: false,
			block: "global-privacy-control",
		}),
	).toMatch(/Global Privacy Control/);
	expect(replayUnavailableReason({ strict: false, block: null })).toBeNull();
});
