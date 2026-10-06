import { expect, it } from "vitest";
import { renderProjectContextPacket } from "./project-context-packet";

it("separates implementation, interfaces, constraints and historical verification", () => {
	const content = renderProjectContextPacket({
		capability: "Branch selection",
		implementation: [
			{
				symbol: "selectBranch",
				responsibility: "stage a per-chat branch until submission",
			},
		],
		interfaces: ["selectedBranch is not workingBranch"],
		constraints: ["Do not rename a user branch"],
		verification: [
			{
				command: "pnpm test branches",
				scope: "unit tests only",
				outcome: "passed",
			},
		],
		unresolved: ["Live provider checkout not verified"],
	});
	expect(content).toContain("Existing implementation:");
	expect(content).toContain("not current proof");
	expect(content).toContain("Live provider checkout not verified");
});

it("rejects oversized packets rather than silently dropping constraints", () => {
	expect(() =>
		renderProjectContextPacket({
			capability: "x".repeat(400),
			implementation: [
				{ symbol: "x".repeat(400), responsibility: "x".repeat(400) },
			],
			interfaces: ["x".repeat(400)],
			constraints: ["x".repeat(400)],
			verification: [],
			unresolved: ["x".repeat(400)],
		}),
	).toThrow("Condense");
});
