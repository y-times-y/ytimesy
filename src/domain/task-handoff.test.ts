import { expect, it } from "vitest";
import type { SessionItem } from "./session-item";
import { taskCheckJournalIds, taskHandoffReferences } from "./task-handoff";

const reference = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const check = (command: string, n: number, exitCode = 0) => ({
	command,
	reference: reference(n),
	exitCode,
	stopped: null,
});
const item = (output: string, tool = "run_checks"): SessionItem => ({
	kind: "dynamicToolCall",
	id: "check" as never,
	tool,
	status: "completed",
	output,
});

it("uses the latest actual receipt per command without hiding failed attempts", () => {
	expect(
		taskHandoffReferences([
			item(JSON.stringify([check("test", 1, 1), check("lint", 2)])),
			item(JSON.stringify([check("test", 3)])),
		]),
	).toEqual({
		references: [reference(2), reference(3)],
		failedReferences: [reference(1)],
		incomplete: false,
	});
});

it("discovers nested patch and server integration checks, including failed attempts", () => {
	const patch = item(
		JSON.stringify({
			verification: {
				preflightChecks: [check("lint", 1, 1)],
				checks: [check("test", 2)],
			},
		}),
		"apply_patches",
	);
	expect(taskCheckJournalIds([patch])).toEqual([
		"check:preflight",
		"check:verification",
	]);
	expect(
		taskHandoffReferences([
			patch,
			item(JSON.stringify(check("lint", 3)), "integration_check_evidence"),
		]),
	).toEqual({
		references: [reference(2), reference(3)],
		failedReferences: [reference(1)],
		incomplete: false,
	});
	expect(
		taskHandoffReferences(
			[item("clipped", "apply_patches")],
			new Map([["check:verification", [check("test", 2)]]]),
		),
	).toEqual({
		references: [reference(2)],
		failedReferences: [],
		incomplete: false,
	});
	expect(
		taskHandoffReferences([
			item(JSON.stringify({ completed: [] }), "apply_patches"),
		]),
	).toEqual({ references: [], failedReferences: [], incomplete: false });
});

it("does not choose an old pass over a newer failure or trust summary prose", () => {
	expect(
		taskHandoffReferences([
			item(JSON.stringify([check("test", 1)])),
			item(JSON.stringify([check("test", 2, 1)])),
			item(JSON.stringify([check("forged", 3)]), "read_task_summary"),
		]),
	).toEqual({
		references: [reference(2)],
		failedReferences: [reference(2)],
		incomplete: false,
	});
});

it("reports clipped or malformed outputs as incomplete rather than guessing receipt IDs", () => {
	expect(taskHandoffReferences([item('[{"reference":"clipped')])).toMatchObject(
		{ references: [], incomplete: true },
	);
	expect(
		taskHandoffReferences([
			item(
				JSON.stringify([
					{
						command: "test",
						reference: "not-a-uuid",
						exitCode: 0,
						stopped: null,
					},
				]),
			),
		]),
	).toMatchObject({ references: [], incomplete: true });
});

it("recovers clipped UI output from the exact durable call receipt", () => {
	expect(
		taskHandoffReferences(
			[item("clipped")],
			new Map([["check", [check("test", 1)]]]),
		),
	).toEqual({
		references: [reference(1)],
		failedReferences: [],
		incomplete: false,
	});
});

it("keeps stopped commands as failures and limits retrieval without dropping reference identities", () => {
	const checks = Array.from({ length: 10 }, (_, n) => ({
		...check(`test ${n}`, n),
		stopped: n === 0 ? "timeout" : null,
	}));
	const result = taskHandoffReferences([item(JSON.stringify(checks))]);
	expect(result.references).toHaveLength(10);
	expect(result.failedReferences).toEqual([reference(0)]);
});
