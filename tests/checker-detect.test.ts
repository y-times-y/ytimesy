import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	blindId,
	controlRates,
	failingRates,
	failureEvidence,
	formatRates,
	GRADE_LABELS,
	type Grade,
	gradeFromUnknown,
	gradingPrompt,
	outcomeOf,
	parseGrade,
} from "../scripts/checker-detect/grading";
import {
	execHeader,
	isAppleDouble,
	isPatchArtifact,
	outsideFiles,
	parseRestoreLog,
	patchDirectory,
	restoreProblems,
	restoreScript,
	sidecarStateProblem,
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

	it("builds a blind prompt with the full findings and parses the grade", () => {
		const prompt = gradingPrompt({
			instruction: "Do it.",
			evidence: "FAILED test_total: 9 != 10",
			findings: {
				verdict: "fail",
				failures: ["total off by one"],
				unmetRequirements: ["total off by one", "missing header"],
				notes: "",
				requirements: [
					{ requirement: "out.json exists", met: true, evidence: "ls" },
					{ requirement: "total exact", met: false, evidence: "9 vs 10" },
					{ requirement: "fast", met: null, evidence: "" },
				],
				assumptions: [
					{ assumption: "inclusive", alternative: "exclusive", outcome: "10" },
				],
			},
		});
		expect(prompt).toContain("1. total off by one\n2. missing header");
		expect(prompt).toContain("- [met] out.json exists -- ls");
		expect(prompt).toContain("- [NOT MET] total exact -- 9 vs 10");
		expect(prompt).toContain("- [unchecked] fast");
		expect(prompt).toContain(
			"- inclusive | alternative: exclusive | outcome: 10",
		);
		for (const label of GRADE_LABELS) expect(prompt).toContain(`"${label}"`);
		expect(prompt).not.toMatch(/verdict/i);
		expect(
			parseGrade(
				'{"cause":"total","label":"partial","finding":2,"reason":"r"}',
			),
		).toEqual({ cause: "total", label: "partial", finding: 2, reason: "r" });
		expect(parseGrade('{"label":"maybe"}')).toBeNull();
		expect(blindId("a.b")).toMatch(/^S-[0-9a-f]{8}$/);
		expect(blindId("a.b")).toBe(blindId("a.b"));
	});

	it("maps grades in the earlier two-label format", () => {
		const legacy = (otherReal: boolean | null) =>
			parseGrade(
				JSON.stringify({ cause: "c", label: "other", otherReal, reason: "" }),
			);
		expect(legacy(true)).toMatchObject({ label: "other_real", legacy: true });
		expect(legacy(false)).toMatchObject({ label: "wrong", legacy: true });
		expect(legacy(null)).toMatchObject({ label: "none", legacy: true });
		expect(
			gradeFromUnknown({
				label: "named_cause",
				otherReal: null,
				cause: "",
				reason: "",
			})?.label,
		).toBe("named_cause");
	});

	it("scores outcomes; unfit samples stay out of every rate", () => {
		const grade = (label: Grade["label"]): Grade => ({
			label,
			cause: "",
			reason: "",
		});
		const failing = [
			outcomeOf({
				kind: "failing",
				verdict: "fail",
				grade: grade("named_cause"),
			}),
			outcomeOf({
				kind: "failing",
				verdict: "unsure",
				grade: grade("partial"),
			}),
			outcomeOf({
				kind: "failing",
				verdict: "fail",
				grade: grade("other_real"),
			}),
			outcomeOf({ kind: "failing", verdict: "fail", grade: grade("wrong") }),
			outcomeOf({ kind: "failing", verdict: "unsure", grade: grade("none") }),
			outcomeOf({ kind: "failing", verdict: "pass", grade: null }),
			outcomeOf({ kind: "failing", verdict: "fail", grade: null }),
			outcomeOf({ kind: "failing", verdict: null, grade: null }),
			outcomeOf({
				kind: "failing",
				verdict: "fail",
				grade: grade("named_cause"),
				unfit: true,
			}),
		];
		expect(failing).toEqual([
			"named_cause",
			"partial",
			"other_real",
			"wrong",
			"none",
			"missed",
			"ungraded",
			"no_run",
			"unfit",
		]);
		const rates = failingRates(failing);
		expect(rates).toMatchObject({
			n: 9,
			named: 1,
			partial: 1,
			otherReal: 1,
			wrong: 1,
			none: 1,
			missed: 1,
			ungraded: 1,
			noRun: 1,
			unfit: 1,
		});
		expect(rates.detectionRate).toBeCloseTo(1 / 6);
		expect(rates.missRate).toBeCloseTo(1 / 6);
		expect(formatRates("x", rates)).toContain("unfit (left out) 1");
		const controls = controlRates([
			outcomeOf({ kind: "control", verdict: "fail", grade: null }),
			outcomeOf({ kind: "control", verdict: "pass", grade: null }),
			outcomeOf({ kind: "control", verdict: "unsure", grade: null }),
			outcomeOf({ kind: "control", verdict: null, grade: null }),
			outcomeOf({ kind: "control", verdict: "fail", grade: null, unfit: true }),
		]);
		expect(controls).toMatchObject({
			n: 5,
			ran: 3,
			unfit: 1,
			falseAlarms: 1,
			unsure: 1,
		});
		expect(controls.falseAlarmRate).toBeCloseTo(1 / 3);
	});
});

describe("restore fidelity", () => {
	const sidecarTask = environment({
		id: "portal-task",
		sidecars: ["portal"],
		artifacts: [
			{ source: "/app", service: "main", exclude: [] },
			{ source: "/audit/log.jsonl", service: "portal", exclude: [] },
		],
	});

	it("leaves AppleDouble entries out, widens modes from the image and re-checks a restarted sidecar's files", () => {
		const script = restoreScript(sidecarTask, "/r");
		expect(script).toContain("--exclude='._*' -xzf");
		expect(script).toContain('echo "APPLEDOUBLE');
		expect(script).toContain("modes 'main' '/app' \"$BEFORE/0\"");
		expect(script).toContain(
			"fixmodes 0 'main' '/app' '/r/workspace/0/app' \"$BEFORE/0\"",
		);
		// The working directory is replaced: it must hold no file the artifact lacked.
		expect(script).toContain("'/r/workspace/0/app' RESTORED 1");
		expect(script).toContain(
			"verify 1 'portal' '/audit/log.jsonl' '/r/workspace/1/log.jsonl' RECHECK",
		);
		expect(script).toContain("! -perm -u=r ! -perm -o=r -exec setfacl -b");
		expect(isAppleDouble("./0/._evalbench")).toBe(true);
		expect(isAppleDouble("./0/evalbench/._.py")).toBe(true);
		expect(isAppleDouble("./0/a._b")).toBe(false);
		expect(execHeader(new TextEncoder().encode("#!/b"))).toBe(true);
		expect(execHeader(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(true);
		expect(execHeader(new TextEncoder().encode("abcd"))).toBe(false);
	});

	it("names extra files, a sidecar that rewrote its state and leftover AppleDouble files", () => {
		const result = parseRestoreLog(
			[
				"APPLEDOUBLE 2",
				"MODES 0 1",
				"RESTORED 0 extra 12",
				"RESTORED 1 ok 1",
				"SIDECAR portal healthy",
				"RECHECK 1 mismatch 1",
				"ABSENT /tests",
				"ABSENT /solution",
				"RESTORE_DONE",
			].join("\n"),
		);
		expect(result.modes).toEqual([{ index: 0, changed: 1 }]);
		expect(result.rechecks).toEqual([
			{ index: 1, state: "mismatch", files: 1 },
		]);
		expect(restoreProblems(sidecarTask, result)).toEqual([
			"2 AppleDouble file(s) in the workspace",
			"artifact /app holds files the artifact did not have",
			"sidecar portal changed /audit/log.jsonl when it restarted (state not kept)",
		]);
	});

	it("marks tasks whose sidecar state cannot be restored", () => {
		expect(sidecarStateProblem(environment())).toBeNull();
		expect(sidecarStateProblem(sidecarTask)).toMatch(/does not reload them/);
		expect(
			sidecarStateProblem(
				environment({
					sidecars: ["feed"],
					artifacts: [{ source: "/w", service: "main", exclude: [] }],
				}),
			),
		).toMatch(/start fresh/);
		expect(
			sidecarStateProblem({ ...sidecarTask, id: "heat-pump-warranty" }),
		).toBeNull();
	});

	it("runs the restore end to end against a fake docker: no AppleDouble file, image modes kept, extra files caught", () => {
		const dir = mkdtempSync(join(tmpdir(), "checker-restore-e2e-"));
		try {
			// The "container" is a directory; docker exec/cp act on it.
			const box = join(dir, "box");
			const bin = join(dir, "bin");
			execFileSync("mkdir", [
				"-p",
				`${box}/app`,
				bin,
				`${dir}/root/stage/0/app`,
			]);
			writeFileSync(`${box}/app/run.sh`, "#!/bin/sh\necho old\n", {
				mode: 0o755,
			});
			writeFileSync(`${box}/app/stale.txt`, "stale\n");
			writeFileSync(`${dir}/root/stage/0/app/run.sh`, "#!/bin/sh\necho new\n", {
				mode: 0o644,
			});
			writeFileSync(`${dir}/root/stage/0/app/._run.sh`, "appledouble");
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/bash",
					`BOX=${box}`,
					'case "$1" in',
					// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
					'  exec) shift; while [[ "$1" == -* ]]; do case "$1" in -u|-w|-e) shift 2;; *) shift;; esac; done; shift; args=(); for a in "$@"; do args+=("${a//\\/app/$BOX/app}"); done; if [ ${#args[@]} = 1 ]; then sed "s|/app|$BOX/app|g" | sh; else "${args[@]}" | sed "s|$BOX||g"; fi;;',
					// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
					'  cp) src=$2; dst=$3; if [ "$dst" = - ]; then p=${src#*:}; tar -C "$BOX$(dirname "$p")" -cf - "$(basename "$p")"; else p=${dst#*:}; if [[ "$src" == */. ]]; then cp -a "$src" "$BOX$p/"; else cp -p "$src" "$BOX$p"; fi; fi;;',
					"  *) ;;",
					"esac",
				].join("\n"),
				{ mode: 0o755 },
			);
			// GNU stat's `-c "%a %n"`, as in a Linux container.
			writeFileSync(
				join(bin, "stat"),
				'#!/bin/sh\nshift 2\nexec python3 -c \'import os,sys\nfor p in sys.argv[1:]: print("%o %s" % (os.stat(p).st_mode & 0o7777, p))\' "$@"\n',
				{ mode: 0o755 },
			);
			execFileSync("tar", [
				"-czf",
				`${dir}/root/workspace.tgz`,
				"-C",
				`${dir}/root/stage`,
				".",
			]);
			writeFileSync(`${dir}/root/runtime.sh`, "WD=/app\nMOUNTS=''\n");
			const task = environment({
				artifacts: [{ source: "/app", service: "main", exclude: [] }],
			});
			writeFileSync(
				`${dir}/root/restore.sh`,
				restoreScript(task, `${dir}/root`),
			);
			const log = execFileSync("bash", [`${dir}/root/restore.sh`], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			});
			const result = parseRestoreLog(log);
			expect(result.appleDouble).toBe(0);
			expect(result.artifacts).toEqual([{ index: 0, state: "ok", files: 1 }]);
			expect(result.modes).toEqual([{ index: 0, changed: 1 }]);
			expect(
				execFileSync("ls", ["-A", `${box}/app`], { encoding: "utf8" }).trim(),
			).toBe("run.sh");
			expect(statSync(`${box}/app/run.sh`).mode & 0o777).toBe(0o755);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
