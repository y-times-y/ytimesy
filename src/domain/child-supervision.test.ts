import { expect, it } from "vitest";
import { childSupervisionSlot } from "./child-supervision";

it("does not wake leaders for ordinary short or progressing child turns", () => {
	expect(childSupervisionSlot(0, 0, 119000)).toBeNull();
	expect(childSupervisionSlot(0, 119000, 120000)).toBeNull();
});
it("checks a quiet child after two minutes and bounds repeated checks", () => {
	expect(childSupervisionSlot(0, 0, 120000)).toBe(1);
	expect(childSupervisionSlot(0, 300000, 300000)).toBe(2);
	expect(childSupervisionSlot(0, 600000, 600000)).toBe(3);
	expect(childSupervisionSlot(0, 900000, 900000)).toBe(3);
});
