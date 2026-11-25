import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the connect prompt visible on phones: the failure wrapper carries role=alert (small screens hide the others)", () => {
	const source = readFileSync(
		"src/features/projects/workspace-status.tsx",
		"utf8",
	);
	const block = source.slice(
		source.indexOf("needsGithubSetup(current.errorMessage)"),
	);
	expect(block.slice(0, 200)).toContain('role="alert"');
});
