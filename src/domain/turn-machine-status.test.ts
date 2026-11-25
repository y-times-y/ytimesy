import { expect, it } from "vitest";
import {
	startingMachineItem,
	withoutStartingMachine,
} from "./turn-machine-status";

it("shows a calm status and removes it when the step runs again", () => {
	const item = startingMachineItem("turn1");
	expect(item.message).toBe("Starting machine…");
	expect(item.message).not.toMatch(/error|fail|limit|retry/i);
	expect(withoutStartingMachine([item])).toEqual([]);
});
