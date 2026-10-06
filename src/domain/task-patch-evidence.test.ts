import { expect, it } from "vitest";
import {
	integratedTaskWriter,
	type TaskPatchIdentity,
} from "./task-patch-evidence";

const writers = [{ id: "a" }, { id: "b" }, { id: "integration" }];
const reviews = new Map<string, TaskPatchIdentity>(
	writers.map((w) => [
		w.id,
		{
			taskId: w.id,
			sha256: w.id === "a" ? "a".repeat(64) : "b".repeat(64),
			base: "c".repeat(40),
		},
	]),
);
const imported = (id: string, destinationId = "integration") => {
	const patch = reviews.get(id);
	if (!patch) throw new Error("Missing test review");
	return { ...patch, destinationId };
};
it("requires all accepted writers, not just any sibling", () => {
	expect(() => integratedTaskWriter(writers, [imported("a")], reviews)).toThrow(
		"every writable task",
	);
	expect(
		integratedTaskWriter(writers, [imported("a"), imported("b")], reviews).id,
	).toBe("integration");
});
it("rejects stale import evidence and ambiguous cyclic integration", () => {
	expect(() =>
		integratedTaskWriter(
			writers,
			[imported("a"), { ...imported("b"), sha256: "d".repeat(64) }],
			reviews,
		),
	).toThrow();
	expect(() =>
		integratedTaskWriter(
			writers,
			[imported("a"), imported("b"), imported("integration", "a")],
			reviews,
		),
	).toThrow();
});
it("supports a single builder and transitive completed integration", () => {
	expect(integratedTaskWriter([writers[0]], [], reviews).id).toBe("a");
	expect(
		integratedTaskWriter(writers, [imported("a", "b"), imported("b")], reviews)
			.id,
	).toBe("integration");
});
