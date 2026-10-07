import { expect, it } from "vitest";
import {
	requireAssignedTaskChecks,
	verificationCommandIdentity,
} from "./task-verification-assignment";

const assignment = {
	commands: ["pnpm run test", "pnpm typecheck"],
	sourcePaths: ["src/a.ts", "src/b.ts"],
	finalChecks: ["pnpm build"],
};

it("requires every assigned check to bind all owned files, not merely one successful receipt", () => {
	const checks = [
		{ command: "corepack pnpm test", sourcePaths: assignment.sourcePaths },
		{ command: "pnpm run typecheck", sourcePaths: assignment.sourcePaths },
	];
	expect(() => requireAssignedTaskChecks(assignment, checks)).not.toThrow();
	expect(() =>
		requireAssignedTaskChecks(assignment, checks.slice(0, 1)),
	).toThrow("missing a command");
	expect(() =>
		requireAssignedTaskChecks(assignment, [
			{ ...checks[0], sourcePaths: ["src/a.ts"] },
			checks[1],
		]),
	).toThrow("owned-source binding");
});

it("does not conflate different commands, flags, working directories or shell compositions", () => {
	expect(verificationCommandIdentity(" corepack pnpm run test ")).toBe(
		"pnpm run test",
	);
	for (const command of [
		"pnpm test --filter x",
		"cd x && pnpm test",
		"FOO=x pnpm test",
		"pnpm test; true",
		"npm run test",
	])
		expect(verificationCommandIdentity(command)).not.toBe("pnpm run test");
});
