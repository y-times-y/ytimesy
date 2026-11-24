import { expect, it } from "vitest";
import { spentWindowReset } from "./plan-spent";

it("reads a plan as spent until its used-up window resets, and not after", () => {
	const now = 1_000;
	const usage = {
		windows: [
			{ id: "5h", usedPercent: 40, resetsAt: 5_000 },
			{ id: "weekly", usedPercent: 100, resetsAt: 9_000 },
		],
	};
	expect(spentWindowReset(usage, now)).toBe(9_000);
	expect(spentWindowReset(usage, 10_000)).toBeNull();
	expect(
		spentWindowReset({ windows: [{ usedPercent: 99, resetsAt: 9_000 }] }, now),
	).toBeNull();
	expect(spentWindowReset(null, now)).toBeNull();
});
