import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	COMPACT_INSTRUCTION,
	endsWithCompactCommand,
	withCompactInstruction,
} from "./compact-command";

const user = (content: ModelMessage["content"]) =>
	({ role: "user", content }) as ModelMessage;

describe("/compact", () => {
	it("is recognized only as the whole last user message", () => {
		expect(endsWithCompactCommand([user("hi"), user(" /compact ")])).toBe(true);
		expect(
			endsWithCompactCommand([user([{ type: "text", text: "/compact" }])]),
		).toBe(true);
		expect(endsWithCompactCommand([user("/compact now please")])).toBe(false);
		expect(endsWithCompactCommand([user("/compact"), user("next")])).toBe(
			false,
		);
		expect(
			endsWithCompactCommand([{ role: "assistant", content: "/compact" }]),
		).toBe(false);
	});

	it("reads an instruction in place of the command, and leaves other history alone", () => {
		const history = [user("earlier"), user("/compact")];
		const replaced = withCompactInstruction(history);
		expect(replaced).toEqual([
			user("earlier"),
			{ role: "user", content: COMPACT_INSTRUCTION },
		]);
		// Once replaced, a resumed step no longer forces another compaction.
		expect(endsWithCompactCommand(replaced)).toBe(false);
		const plain = [user("earlier")];
		expect(withCompactInstruction(plain)).toBe(plain);
	});
});
