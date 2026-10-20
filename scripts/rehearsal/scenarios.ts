// Rehearsal scenarios: what each scripted agent does, and what must be
// observable afterwards. Every agent's conversation is told apart by a
// marker in its first message: the task text carries [rehearsal:<id>], and
// the scripted leads write [rehearsal:<role>] into their briefs.
import type { AgentScript, Reply, ScriptContext } from "./fake-codex";

export type Check = { name: string; ok: boolean; detail?: string };

export type ScenarioId = "builder" | "review" | "fusion" | "subagents";

export type Scenario = {
	readonly id: ScenarioId;
	readonly title: string;
	readonly variant: string;
	readonly scripts: AgentScript[];
};

const runCode = (code: string): Reply => ({
	calls: [{ name: "run_code", args: { code } }],
});
const bash = (command: string, timeout?: number): Reply => ({
	calls: [{ name: "bash", args: timeout ? { command, timeout } : { command } }],
});
const marked = (tag: string) => (first: string) => first.includes(tag);
const isChecker = (first: string) =>
	first.includes("You are an independent checker");

/** The regression test's last line, which the builder's edit extends. */
const TEST_FILE = "tests/regression_test.cc";
const TEST_LINE = '  std::cout << "all regression tests passed\\n";';
const builderEdit = {
	path: TEST_FILE,
	edits: [
		{
			old_string: TEST_LINE,
			new_string: `  std::cout << "rehearsal edit applied\\n";\n${TEST_LINE}`,
		},
	],
};

/** A program with three independent reads in parallel. */
const PARALLEL_READS = `const [make, report, shell] = await Promise.all([
  tools.read({ path: "Makefile" }),
  tools.read({ path: "crash_report.txt", limit: 5 }),
  tools.bash({ command: "pwd; id -u; test -e /.dockerenv && echo in-container; git status --short" }),
]);
return JSON.stringify({ make: String(make).slice(0, 200), report: String(report).slice(0, 120), shell });`;

const EDIT_AND_TEST = `const edited = await tools.edit(${JSON.stringify(builderEdit)});
const test = await tools.bash({ command: "make test", timeout: 600 });
return JSON.stringify({ edited, test });`;

// ---------------------------------------------------------------------------
// a. builder: run_code with parallel reads, an edit and `make test`; a bash
// command that outlives its yield, then `ytimesy-job wait`.

function builderScript(tag: string): AgentScript {
	return {
		name: "builder",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: ({ step, last }) => {
			if (step === 0) return runCode(PARALLEL_READS);
			if (step === 1) return runCode(EDIT_AND_TEST);
			if (step === 2)
				return bash("sleep 75; make repro; echo REPRO_EXIT=$?", 600);
			if (step === 3) {
				const id = /\(ID ([A-Za-z0-9_.:-]+)\)/.exec(last[0]?.output ?? "")?.[1];
				if (id) return bash(`ytimesy-job wait ${id}`, 600);
				return bash("echo detached-command-did-not-yield");
			}
			// The provider flake from rl-tests-sol: a 200 without a body, once.
			return {
				fault: "empty-body",
				after: { text: "Rehearsal builder finished." },
			};
		},
	};
}

// ---------------------------------------------------------------------------
// b. review=on: the builder changes a file and finishes; the checker reads
// the brief, copies the checkout, writes its own test, runs `make test` and
// that test, and fails round 1 with a failing test; the builder answers the
// findings and finishes; round 2 passes.

const NOTICE = "independent checker reviewed your work";

function reviewBuilderScript(tag: string): AgentScript {
	return {
		name: "review-builder",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: ({ step, userTexts, calls }) => {
			const notices = userTexts.filter((text) => text.includes(NOTICE));
			if (step === 0) return runCode(EDIT_AND_TEST);
			if (!notices.length) return { text: "Rehearsal change made and tested." };
			// After each review's findings: run the tests again, then finish.
			const answered = calls.filter((call) =>
				JSON.stringify(call.args).includes("FINDINGS_ADDRESSED"),
			).length;
			if (answered < notices.length)
				return runCode(`const edited = await tools.edit(${JSON.stringify({
					path: TEST_FILE,
					edits: [
						{
							old_string: '"rehearsal edit applied\\n"',
							new_string: '"rehearsal edit applied (after review)\\n"',
						},
					],
				})});
const test = await tools.bash({ command: "make test && echo FINDINGS_ADDRESSED", timeout: 600 });
return JSON.stringify({ edited, test });`);
			return { text: `Addressed review ${notices.length}.` };
		},
	};
}

/** Pulls the checker brief's paths out of its text. */
export function checkerPaths(brief: string) {
	const copy = /`(mkdir -p (\S+) && cp -a (\S+)\/\. \S+\/)`/.exec(brief);
	const scratch = /under (\S+)\/tests,/.exec(brief)?.[1];
	const diff = /`(git -C \S+ diff [^`]+)`/.exec(brief)?.[1];
	return {
		copy: copy?.[1],
		work: copy?.[2],
		checkout: copy?.[3],
		scratch,
		diff,
	};
}

const PROBE = (work: string) => `#!/bin/bash
# The checker's own test: the copy built in place and runs.
set -e
cd ${work}
test -x build/regression_test
./build/regression_test | grep -q "rehearsal edit applied"
echo PROBE_PASSED`;

function checkerScript(tag: string): AgentScript {
	let reviews = 0;
	return {
		name: "checker",
		match: (first) => isChecker(first) && first.includes(tag),
		reply: ({ step, userTexts, last, calls }) => {
			const paths = checkerPaths(userTexts.join("\n"));
			if (step === 0) {
				reviews++;
				return runCode(`const r = await tools.bash({ command: ${JSON.stringify(`pwd; id -u; ls; ${paths.diff ?? "echo NO-DIFF-COMMAND"} | head -40`)} });
return JSON.stringify(r);`);
			}
			if (step === 1)
				return runCode(`const copy = await tools.bash({ command: ${JSON.stringify(`${paths.copy ?? "echo NO-COPY-COMMAND; false"} && ls -ld ${paths.work}`)} });
const write = await tools.bash({ command: ${JSON.stringify(`mkdir -p ${paths.scratch}/tests && cat > ${paths.scratch}/tests/rehearsal_probe.sh <<'EOF'\n${PROBE(paths.work ?? "/nonexistent")}\nEOF\nchmod +x ${paths.scratch}/tests/rehearsal_probe.sh && echo PROBE_WRITTEN`)} });
const make = await tools.bash({ command: ${JSON.stringify(`cd ${paths.work} && rm -rf build && make test && ls -ld build`)}, timeout: 600 });
const probe = await tools.bash({ command: ${JSON.stringify(`bash ${paths.scratch}/tests/rehearsal_probe.sh`)}, timeout: 120 });
return JSON.stringify({ copy, write, make, probe });`);
			const results = last[0]?.output ?? "";
			void calls;
			const passed = /PROBE_PASSED/.test(results);
			const round = reviews;
			// Round 1 fails on purpose so the builder gets findings; round 2 passes.
			const fail = round === 1;
			return {
				text: JSON.stringify({
					verdict: fail ? "fail" : passed ? "pass" : "unsure",
					failures: fail
						? [
								`Rehearsal finding: the regression output must be confirmed by the checker's test (probe ${passed ? "passed" : "failed"})`,
							]
						: [],
					tests: [
						{
							name: "rehearsal probe: the copy builds in place and prints the edit",
							command: `bash ${paths.scratch}/tests/rehearsal_probe.sh`,
							passed: fail ? false : passed,
							output: results.slice(-400),
						},
					],
					requirements: [
						{
							requirement: "make test passes",
							met: /all regression tests passed/.test(results),
							evidence: "make test in the copy",
						},
					],
					assumptions: [],
					notes: `rehearsal review ${round}`,
				}),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// c. lead=fusion: the lead starts its sidekick, applies its patch, sends
// feedback, applies the second round's patch and finishes.

/** Reports from writers arrive as user-role messages naming the patch. */
function reports(context: ScriptContext) {
	return context.userTexts
		.slice(1)
		.map((text) => /[^\s`'"()]+\.patch\b/.exec(text)?.[0])
		.filter((path): path is string => Boolean(path));
}

function leadScript(
	tag: string,
	input: { feedbackRounds: number; startResearcher?: boolean },
): AgentScript {
	return {
		name: input.startResearcher ? "subagents-lead" : "fusion-lead",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: (context) => {
			const { calls } = context;
			const started = calls.filter((call) => call.name === "agent");
			const applied = calls.filter(
				(call) =>
					call.name === "run_code" &&
					JSON.stringify(call.args).includes("git apply"),
			).length;
			const sent = calls.filter((call) => call.name === "agent_send").length;
			const found = reports(context);
			if (!started.length) {
				const calls_: { name: string; args: unknown }[] = [
					{
						name: "agent",
						args: {
							role: "writer",
							title: "Rehearsal writer",
							brief: `[rehearsal:${input.startResearcher ? "writer" : "sidekick"}] Add a one-line comment to the top of include/mvcc_lsm/types.h saying "rehearsal round 1". Run git diff --stat. Report the patch.`,
						},
					},
				];
				if (input.startResearcher)
					calls_.push({
						name: "agent",
						args: {
							role: "researcher",
							title: "Rehearsal researcher",
							wait: true,
							brief:
								"[rehearsal:researcher] Report the working directory, your uid and what `make -n test` would run. Do not change anything.",
						},
					});
				return { calls: calls_ };
			}
			if (found.length > applied) {
				const patch = found[applied];
				return runCode(`const apply = await tools.bash({ command: ${JSON.stringify(`git apply -3 ${patch} && git diff --stat && echo PATCH_APPLIED`)} });
return JSON.stringify(apply);`);
			}
			if (applied > sent && sent < input.feedbackRounds)
				return {
					calls: [
						{
							name: "agent_send",
							args: {
								id: "1",
								message: `[rehearsal:feedback] Good. Round ${sent + 2}: add a one-line comment "rehearsal round ${sent + 2}" to the top of src/lsm_db.cc and report the patch.`,
							},
						},
					],
				};
			if (applied >= input.feedbackRounds + 1)
				return { text: `Rehearsal lead finished: ${applied} patches applied.` };
			// Waiting for the writer's report: keep the turn alive.
			return bash("sleep 15; echo waiting-for-report");
		},
	};
}

function writerScript(name: string, tag: string): AgentScript {
	const file = ["include/mvcc_lsm/types.h", "src/lsm_db.cc"];
	return {
		name,
		match: marked(tag),
		reply: ({ step }) => {
			const round = Math.floor(step / 2);
			if (step % 2 === 0)
				return runCode(`const before = await tools.bash({ command: "pwd; id -u; git log --oneline -3; git status --short" });
const path = ${JSON.stringify(file[round] ?? file[0])};
const text = await tools.read({ path });
const first = String(text).split("\\n")[0].replace(/^\\s*\\d+[\\t|:]\\s?/, "");
const edited = await tools.edit({ path, edits: [{ old_string: first, new_string: "// rehearsal round ${round + 1}\\n" + first }] });
const after = await tools.bash({ command: "git diff --stat" });
return JSON.stringify({ before, edited, after });`);
			return {
				text: `Rehearsal ${name} round ${round + 1} done: one comment line added.`,
			};
		},
	};
}

function researcherScript(): AgentScript {
	return {
		name: "researcher",
		match: marked("[rehearsal:researcher]"),
		reply: ({ step }) => {
			if (step === 0)
				return runCode(`const r = await tools.bash({ command: "pwd; id -u; test -e /.dockerenv && echo in-container; make -n test | head -5; touch .reader-write-probe 2>&1 || echo READ_ONLY_OK" });
return JSON.stringify(r);`);
			return {
				text: "Rehearsal researcher report: the checkout builds with make test.",
			};
		},
	};
}

export function scenarios(): Scenario[] {
	return [
		{
			id: "builder",
			title:
				"a. builder: run_code (parallel reads, edit, make test), detached bash",
			variant: "codeMode=primary",
			scripts: [builderScript("[rehearsal:builder]")],
		},
		{
			id: "review",
			title:
				"b. review=on: checker copies, writes its own test, runs make test; findings reach the builder",
			variant:
				"codeMode=primary,subagents=on,review=on,roleModels.checker=codex:gpt-6-luna",
			scripts: [
				reviewBuilderScript("[rehearsal:review]"),
				checkerScript("[rehearsal:review]"),
			],
		},
		{
			id: "fusion",
			title: "c. lead=fusion: sidekick runs, two rounds of patches, teardown",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				leadScript("[rehearsal:fusion]", { feedbackRounds: 1 }),
				writerScript("sidekick", "[rehearsal:sidekick]"),
			],
		},
		{
			id: "subagents",
			title: "d. subagents=on: a researcher in the container, a writer's patch",
			variant: "codeMode=primary,subagents=on",
			scripts: [
				leadScript("[rehearsal:subagents]", {
					feedbackRounds: 0,
					startResearcher: true,
				}),
				writerScript("writer", "[rehearsal:writer]"),
				researcherScript(),
			],
		},
	];
}
