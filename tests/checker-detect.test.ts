import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	blindId,
	controlRates,
	failingRates,
	failureEvidence,
	gradingPrompt,
	outcomeOf,
	parseGrade,
} from "../scripts/checker-detect/grading";
import {
	isPatchArtifact,
	outsideFiles,
	parseRestoreLog,
	patchDirectory,
	restoreProblems,
	restoreScript,
} from "../scripts/checker-detect/restore";
import {
	HELD_OUT_TASKS,
	selectSamples,
	type TaskFacts,
	type TrialSummary,
	workspaceProblem,
} from "../scripts/checker-detect/select";
import type { TaskEnvironment } from "../scripts/hard-set/environment";

const facts = (id: string, extra: Partial<TaskFacts> = {}): TaskFacts => ({
	id,
	gpus: 0,
	mcpServers: 0,
	cpus: 2,
	memoryMb: 4096,
	buildsImage: false,
	hasSidecars: false,
	...extra,
});

const trial = (
	task: string,
	id: string,
	reward: number,
	extra: Partial<TrialSummary> = {},
): TrialSummary => ({
	task,
	trial: `${task}__${id}`,
	path: `/backup/${task}__${id}`,
	reward,
	scored: true,
	artifacts: [
		{ source: "/app/out.txt", service: "main", status: "ok", bytes: 10 },
	],
	evidenceFiles: ["test-stdout.txt"],
	...extra,
});

describe("selectSamples", () => {
	const tasks = [
		...Array.from({ length: 30 }, (_, index) => facts(`task-${index}`)),
		facts("gpu-task", { gpus: 1 }),
		facts("big-task", { cpus: 16 }),
		facts("heat-pump-warranty", { hasSidecars: true }),
		facts("mvcc-lsm-compaction"),
		facts("legacy-utility-triage"),
	];
	const trials = [
		...tasks.flatMap((task) => [
			trial(task.id, "fail1", 0),
			trial(task.id, "fail2", 0),
			trial(task.id, "pass1", 1),
		]),
		trial("heat-pump-warranty", "fail3", 0, {
			artifacts: [
				{
					source: "/audit/decisions.json",
					service: "warranty-portal",
					status: "ok",
					bytes: 5,
				},
			],
		}),
		trial("task-0", "empty", 0, {
			artifacts: [{ source: "/app/", service: "main", status: "ok", bytes: 0 }],
		}),
		trial("task-1", "nostdout", 0, { evidenceFiles: [] }),
		trial("task-2", "unscored", 0, { scored: false }),
	];
	const selection = selectSamples(trials, tasks);
	const kinds = (kind: string) =>
		selection.samples.filter((sample) => sample.kind === kind);

	it("takes every usable failing trial of the held-out tasks", () => {
		expect(
			kinds("held-out")
				.map((sample) => sample.trial)
				.sort(),
		).toEqual(
			[
				...HELD_OUT_TASKS.flatMap((task) => [
					`${task}__fail1`,
					`${task}__fail2`,
				]),
				"heat-pump-warranty__fail3",
			].sort(),
		);
		expect(
			kinds("held-out").find((sample) => sample.trial.endsWith("fail3"))
				?.caveats[0],
		).toMatch(/service sidecar/);
	});

	it("fills the failing sample with one trial per other eligible task", () => {
		const failing = kinds("failing");
		expect(failing.length + kinds("held-out").length).toBe(20);
		expect(new Set(failing.map((sample) => sample.task)).size).toBe(
			failing.length,
		);
		for (const sample of failing) {
			expect(sample.reward).toBeLessThan(1);
			expect(["gpu-task", "big-task"]).not.toContain(sample.task);
			expect(sample.trial).not.toMatch(/empty|nostdout|unscored/);
		}
	});

	it("picks controls from other tasks and is deterministic", () => {
		const controls = kinds("control");
		expect(controls).toHaveLength(8);
		const failingTasks = new Set(
			[...kinds("failing"), ...kinds("held-out")].map((sample) => sample.task),
		);
		for (const sample of controls) {
			expect(sample.reward).toBe(1);
			expect(failingTasks.has(sample.task)).toBe(false);
		}
		expect(selectSamples([...trials].reverse(), [...tasks].reverse())).toEqual(
			selection,
		);
		expect(selection.excludedTasks).toEqual(
			expect.arrayContaining([
				{ task: "gpu-task", reason: "needs a GPU" },
				{ task: "big-task", reason: "needs 16 CPUs (VM cap 8)" },
			]),
		);
	});

	it("rejects workspaces with unsaved or empty artifacts", () => {
		expect(workspaceProblem(trial("t", "a", 0))).toBeNull();
		expect(
			workspaceProblem(
				trial("t", "a", 0, {
					artifacts: [
						{ source: "/app/x", service: "main", status: "failed", bytes: 0 },
					],
				}),
			),
		).toMatch(/\/app\/x \(failed, 0 B\)/);
		expect(workspaceProblem(trial("t", "a", 0, { artifacts: [] }))).toBe(
			"no task artifacts",
		);
	});
});

const environment = (
	extra: Partial<TaskEnvironment> = {},
): TaskEnvironment => ({
	id: "demo",
	dir: "/tmp/demo",
	instruction: "Do it.",
	envImage: "env@sha256:1",
	verifierImage: "verifier@sha256:2",
	compose: { services: { main: {} } },
	sidecars: [],
	cpus: 2,
	memoryMb: 2048,
	storageMb: 4096,
	verifierCpus: 2,
	verifierMemoryMb: 2048,
	verifierTimeoutSec: 300,
	verifierEnv: {},
	solutionEnv: {},
	collect: [],
	artifacts: [],
	gpus: 0,
	mcpServers: 0,
	...extra,
});

describe("restore", () => {
	const patchTask = environment({
		collect: [
			{
				service: "main",
				command:
					"rm -f /tmp/agent.patch && cd /app/site && git add -A && git diff --binary $base -- . > /tmp/agent.patch",
			},
		],
		artifacts: [
			{ source: "/tmp/agent.patch", service: "main", exclude: [] },
			{ source: "/results/out.csv", service: "main", exclude: [] },
			{ source: "/app/", service: "main", exclude: [] },
			{ source: "/audit/log.jsonl", service: "portal", exclude: [] },
		],
	});

	it("recognizes diff artifacts and where they apply", () => {
		const [patch, results, app, audit] = patchTask.artifacts;
		expect(isPatchArtifact(patchTask, patch)).toBe(true);
		expect(patchDirectory(patchTask, patch)).toBe("/app/site");
		expect(isPatchArtifact(patchTask, results)).toBe(false);
		expect(isPatchArtifact(patchTask, audit)).toBe(false);
		expect(isPatchArtifact(environment({ artifacts: [patch] }), patch)).toBe(
			false,
		);
		expect(outsideFiles(patchTask, "/app")).toEqual(["/results/out.csv"]);
		expect(app.source).toBe("/app/");
	});

	it("writes a valid script that restores each artifact, applies the diff and checks the grader's files are absent", () => {
		const script = restoreScript(patchTask, "/work/root");
		const dir = mkdtempSync(join(tmpdir(), "checker-restore-"));
		try {
			writeFileSync(join(dir, "restore.sh"), script);
			execFileSync("bash", ["-n", join(dir, "restore.sh")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(script).toContain("ROOT='/work/root'");
		expect(script).toContain("'/work/root/workspace/2/app'");
		expect(script).toContain("-w '/app/site' \"$MAIN\" git apply --binary");
		expect(script).toContain("PATCH 0 applied");
		expect(script).toContain('restarted="$restarted portal"');
		expect(script).toContain("ABSENT /tests");
		expect(script).toContain("ABSENT /solution");
		// The working directory is replaced (git history kept); not with excludes.
		expect(script).toContain("! -name .git -exec rm -rf {} +");
		const excluded = restoreScript(
			environment({
				artifacts: [{ source: "/app", service: "main", exclude: ["*.pyc"] }],
			}),
		);
		expect(excluded).not.toContain("-exec rm -rf");
		expect(excluded).toContain("ROOT='/tb'");
	});

	it("parses the restore log and names what makes it unfit", () => {
		const log = [
			"RESTORED 0 ok 1",
			"PATCH 0 applied",
			"RESTORED 1 ok        3",
			"RESTORED 2 mismatch 4",
			"RESTORED 3 ok 1",
			"SIDECAR portal healthy",
			"ABSENT /tests",
			"ABSENT /solution",
			"FORBIDDEN ./data/fixture.csv",
			"CHANGED out.txt",
			"CHANGED /app/site/page.tsx",
			"RESTORE_DONE",
		].join("\n");
		const result = parseRestoreLog(log);
		expect(result.artifacts.map((entry) => entry.state)).toEqual([
			"ok",
			"ok",
			"mismatch",
			"ok",
		]);
		expect(result.artifacts[1].files).toBe(3);
		expect(result.changedFiles).toEqual(["out.txt", "/app/site/page.tsx"]);
		expect(result.forbidden).toEqual(["./data/fixture.csv"]);
		expect(restoreProblems(patchTask, result)).toEqual([
			"artifact /app/ mismatch",
		]);
		const broken = parseRestoreLog(
			"RESTORED 0 ok 1\nPATCH 0 failed\nPRESENT /tests\nABSENT /solution\nSIDECAR portal exited",
		);
		expect(restoreProblems(patchTask, broken)).toEqual([
			"restore did not finish",
			"diff /tmp/agent.patch did not apply",
			"artifact /results/out.csv not restored",
			"artifact /app/ not restored",
			"artifact /audit/log.jsonl not restored",
			"sidecar portal is exited",
			"/tests is present",
		]);
	});
});

describe("grading", () => {
	it("condenses the hidden failure: failed tests, details, output tail", () => {
		const evidence = failureEvidence({
			"ctrf.json": JSON.stringify({
				results: {
					summary: { tests: 3, passed: 2, failed: 1 },
					tests: [
						{ name: "test_ok", status: "passed" },
						{ name: "test_total", status: "failed", message: "9 != 10" },
					],
				},
			}),
			"reward.txt": "0",
			"reward_details.json": '{"checks":[{"name":"c1","passed":false}]}',
			"test-stdout.txt": `${"x".repeat(10_000)}END`,
		});
		expect(evidence).toContain("FAILED test_total: 9 != 10");
		expect(evidence).not.toContain("test_ok");
		expect(evidence).toContain("reward.txt: 0");
		expect(evidence).toContain('"passed":false');
		expect(evidence).toContain("END");
		expect(evidence.length).toBeLessThan(12_100);
	});

	it("builds a blind prompt and parses the grade", () => {
		const prompt = gradingPrompt({
			instruction: "Do it.",
			evidence: "FAILED test_total: 9 != 10",
			findings: {
				verdict: "fail",
				failures: ["total off by one"],
				unmetRequirements: ["total off by one", "missing header"],
				notes: "",
			},
		});
		expect(prompt).toContain("1. total off by one\n2. missing header");
		expect(prompt).not.toMatch(/verdict/i);
		expect(
			parseGrade(
				'{"cause":"total","label":"named_cause","otherReal":true,"reason":"r"}',
			),
		).toEqual({
			cause: "total",
			label: "named_cause",
			otherReal: null,
			reason: "r",
		});
		expect(
			parseGrade(
				'x {"cause":"c","label":"other","otherReal":false,"reason":""}',
			)?.otherReal,
		).toBe(false);
		expect(parseGrade('{"label":"maybe"}')).toBeNull();
		expect(blindId("a.b")).toMatch(/^S-[0-9a-f]{8}$/);
		expect(blindId("a.b")).toBe(blindId("a.b"));
	});

	it("scores outcomes into detection, wrong-cause, miss and false-alarm rates", () => {
		const grade = (
			label: "named_cause" | "other",
			otherReal: boolean | null,
		) => ({
			label,
			otherReal,
			cause: "",
			reason: "",
		});
		const failing = [
			outcomeOf({
				kind: "failing",
				verdict: "fail",
				grade: grade("named_cause", null),
			}),
			outcomeOf({
				kind: "failing",
				verdict: "unsure",
				grade: grade("other", true),
			}),
			outcomeOf({
				kind: "failing",
				verdict: "fail",
				grade: grade("other", false),
			}),
			outcomeOf({ kind: "failing", verdict: "pass", grade: null }),
			outcomeOf({ kind: "failing", verdict: "fail", grade: null }),
			outcomeOf({ kind: "failing", verdict: null, grade: null }),
		];
		expect(failing).toEqual([
			"named_cause",
			"other_real",
			"other_not_real",
			"missed",
			"ungraded",
			"no_run",
		]);
		const rates = failingRates(failing);
		expect(rates).toMatchObject({
			n: 6,
			named: 1,
			other: 2,
			otherReal: 1,
			missed: 1,
			ungraded: 1,
			noRun: 1,
		});
		expect(rates.detectionRate).toBeCloseTo(0.25);
		expect(rates.missRate).toBeCloseTo(0.25);
		const controls = controlRates([
			outcomeOf({ kind: "control", verdict: "fail", grade: null }),
			outcomeOf({ kind: "control", verdict: "pass", grade: null }),
			outcomeOf({ kind: "control", verdict: "unsure", grade: null }),
			outcomeOf({ kind: "control", verdict: null, grade: null }),
		]);
		expect(controls).toMatchObject({ n: 4, ran: 3, falseAlarms: 1, unsure: 1 });
		expect(controls.falseAlarmRate).toBeCloseTo(1 / 3);
	});
});
