// Rehearsal scenarios: what each scripted agent does, and what must be
// observable afterwards. Every agent's conversation is told apart by a
// marker in its first message: the task text carries [rehearsal:<id>], and
// the scripted leads write [rehearsal:<role>] into their briefs.
import { HARNESS_EXPLORE_HEADING } from "../../src/domain/sidekick";
import type { AgentScript, Reply, ScriptContext } from "./fake-codex";

export type Check = { name: string; ok: boolean; detail?: string };

export type ScenarioId =
	| "builder"
	| "review"
	| "review-pair"
	| "fusion"
	| "fusion-explore"
	| "fusion-multiturn"
	| "fusion-stuck"
	| "fusion-handback"
	| "fusion-classifier-fail"
	| "subagents"
	| "rigor"
	| "fork";

export type Scenario = {
	readonly id: ScenarioId;
	readonly title: string;
	readonly variant: string;
	/** The chat's reasoning effort (the model's default when unset). */
	readonly reasoning?: string;
	readonly scripts: AgentScript[];
	/** Later user messages, each sent once the chat settled after the one before. */
	readonly followUps?: readonly string[];
	/** Memory on (full mode) for the scenario's user, with this repo content. */
	readonly memory?: Readonly<Record<string, string>>;
	/** Once every message settled: fork the chat at this user message (1-based). */
	readonly forkAt?: number;
	/** Q&A-only messages to fork at too, with the marker each fork must hold. */
	readonly qaForks?: readonly { at: number; marker: string }[];
};

/** A standing rule in the user's memory (scope: always rides on every chat). */
export const MEMORY_RULE =
	"Never commit the build/ directory of the rehearsal project";
/** The user's memory in the memory scenarios: one rule, one topic line. */
const REHEARSAL_MEMORY = {
	"MEMORY.md": "# Memory\n\n## Index\n- conventions.md: project rules\n",
	"conventions.md": `# conventions\n- ${MEMORY_RULE} [scope: always; added: 2026-10-19]\n- The regression tests run with make test and print one line per test [added: 2026-10-18]\n`,
};

const runCode = (code: string): Reply => ({
	calls: [{ name: "run_code", args: { code } }],
});
const bash = (command: string, timeout?: number): Reply => ({
	calls: [{ name: "bash", args: timeout ? { command, timeout } : { command } }],
});
/** The sidekick classifier's requests (src/domain/sidekick-classifier.ts). */
export const CLASSIFIER_MARKER = "Sidekick round summary for classification.";
const isClassifier = (first: string) => first.includes(CLASSIFIER_MARKER);
const marked = (tag: string) => (first: string) =>
	first.includes(tag) && !isClassifier(first);
/** The opening of the checker's brief (src/domain/checker-brief.ts). */
export const CHECKER_MARKER = "You are an independent checker";
const isChecker = (first: string) => first.includes(CHECKER_MARKER);

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

/** rigor=on: the root builder's requirements list (src/domain/rigor.ts). */
export const REQUIREMENTS_INSTRUCTION =
	"- Requirements: before you start, write the request's requirements";
export const LEAD_REQUIREMENTS_INSTRUCTION =
	"- As Main, write the list right after the exploration report";
/** The checker brief's label for the builder's list. */
export const BUILDER_LIST_LABEL =
	"The builder's understanding of the requirements, written before it worked (a claim to compare, not ground truth):";
/** Only the scripted lists carry this, so a file, diff or commit holding it leaked the list. */
export const REQUIREMENTS_MARK = "rh-requirements-list";
export const BUILDER_REQUIREMENTS = [
	`${REQUIREMENTS_MARK}: tests/regression_test.cc prints the rehearsal line`,
	`${REQUIREMENTS_MARK}: make test exits 0 (reading: the whole suite, not one test)`,
];
/** A plan message that opens with the requirements block. */
export const requirementsMessage = (items: readonly string[]) =>
	`Requirements first.\n<requirements>\n${items.map((item) => `- ${item}`).join("\n")}\n</requirements>`;

function reviewBuilderScript(
	tag: string,
	name = "review-builder",
): AgentScript {
	return {
		name,
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: ({ step, userTexts, calls }) => {
			const notices = userTexts.filter((text) => text.includes(NOTICE));
			// The list is written here too: without rigor=on nothing takes it.
			if (step === 0)
				return {
					...runCode(EDIT_AND_TEST),
					text: requirementsMessage(BUILDER_REQUIREMENTS),
				};
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
// b2. review=on, checkerMode=pair: each round's checker is a judge (Sol) that
// briefs a worker (Luna) through checker_worker; the worker copies the
// checkout, writes the probe and runs make test and the probe in the judge's
// scratch as the reader user and reports evidence; the judge spot-checks the
// scratch itself and writes the verdict JSON. Round 1 fails, round 2 passes.

/** The pair's worker conversations carry this in the judge's brief. */
export const PAIR_WORKER_TAG = "[rehearsal:pair-worker]";
/** The opening of the runtime's frame around a judge's brief (src/domain/checker-pair.ts). */
export const PAIR_WORKER_MARKER =
	"You are the worker of an independent checker";

function pairJudgeScript(tag: string): AgentScript {
	let reviews = 0;
	return {
		name: "pair-judge",
		match: (first) => isChecker(first) && first.includes(tag),
		reply: ({ step, userTexts, tools }) => {
			const paths = checkerPaths(userTexts.join("\n"));
			if (step === 0) {
				reviews++;
				if (!tools.includes("checker_worker"))
					return { text: "NO_WORKER_TOOL" };
				return {
					calls: [
						{
							name: "checker_worker",
							args: {
								title: `Run the checks (review ${reviews})`,
								brief: `${PAIR_WORKER_TAG} Copy the checkout and test the copy. SCRATCH=${paths.scratch} WORK=${paths.work} CHECKOUT=${paths.checkout}\n1. Copy: \`${paths.copy}\`.\n2. Write a probe at ${paths.scratch}/tests/rehearsal_probe.sh that checks the copy's build prints the rehearsal line.\n3. Run make test in the copy, then the probe. Report each command, its exit status and the lines that matter.`,
							},
						},
					],
				};
			}
			if (step === 1)
				return runCode(`const r = await tools.bash({ command: ${JSON.stringify(`id -u; ls ${paths.scratch}/tests`)} });
return JSON.stringify(r);`);
			const round = reviews;
			const fail = round === 1;
			return {
				text: JSON.stringify({
					verdict: fail ? "fail" : "pass",
					failures: fail
						? [
								"Rehearsal finding: the regression output must be confirmed by the pair's test",
							]
						: [],
					tests: [
						{
							name: "rehearsal probe: the copy builds in place and prints the edit",
							command: `bash ${paths.scratch}/tests/rehearsal_probe.sh`,
							passed: !fail,
							output: fail ? "rehearsal: failed on purpose" : "PROBE_PASSED",
						},
					],
					requirements: [
						{
							requirement: "make test passes",
							met: true,
							evidence: "the worker's make test in the copy",
						},
					],
					assumptions: [],
					notes: `rehearsal pair review ${round}`,
				}),
			};
		},
	};
}

/**
 * The worker: copies the checkout and writes the probe, runs make test in
 * the copy (waiting it out with ytimesy-job when it outlives its call), runs
 * the probe, then reports its evidence.
 */
function pairWorkerScript(): AgentScript {
	return {
		name: "pair-worker",
		match: (first) => first.includes(PAIR_WORKER_TAG) && !isChecker(first),
		reply: ({ step, userTexts, calls }) => {
			const brief = userTexts.join("\n");
			const value = (key: string) =>
				new RegExp(`${key}=(\\S+)`).exec(brief)?.[1] ?? "/nonexistent";
			const scratch = value("SCRATCH");
			const work = value("WORK");
			const checkout = value("CHECKOUT");
			const probe = `bash ${scratch}/tests/rehearsal_probe.sh`;
			if (step === 0)
				return runCode(`const who = await tools.bash({ command: "pwd; id -u; touch .worker-write-probe 2>&1 || echo READ_ONLY_OK" });
const copy = await tools.bash({ command: ${JSON.stringify(`mkdir -p ${work} && cp -a ${checkout}/. ${work}/ && ls -ld ${work}`)} });
const write = await tools.bash({ command: ${JSON.stringify(`mkdir -p ${scratch}/tests && cat > ${scratch}/tests/rehearsal_probe.sh <<'EOF'\n${PROBE(work)}\nEOF\nchmod +x ${scratch}/tests/rehearsal_probe.sh && echo PROBE_WRITTEN`)} });
return JSON.stringify({ who, copy, write });`);
			const shells = calls.filter((call) => call.name === "bash");
			if (!shells.length)
				return bash(
					`cd ${work} && rm -rf build && make test && ls -ld build`,
					600,
				);
			const yielded =
				/Still running after [\s\S]*?\(ID ([A-Za-z0-9_.:-]+)\)/.exec(
					shells.at(-1)?.output ?? "",
				)?.[1];
			if (yielded) return bash(`ytimesy-job wait ${yielded}`, 600);
			if (!shells.some((call) => JSON.stringify(call.args).includes(probe)))
				return bash(probe, 120);
			const outputs = shells.map((call) => call.output).join("\n");
			return {
				text: `Evidence: make test in ${work}: ${/all regression tests passed/.test(outputs) ? "exit 0 (all regression tests passed)" : "did not pass"}; \`${probe}\`: ${/PROBE_PASSED/.test(outputs) ? "PROBE_PASSED" : "failed"}.`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// d. subagents=on: the builder starts a forked writer and applies its patch,
// and an awaited researcher reports from the shared VM.

/** Reports from writers arrive as user-role messages naming the patch. */
function reports(context: ScriptContext) {
	return context.userTexts
		.slice(1)
		.map((text) => /[^\s`'"()]+\.patch\b/.exec(text)?.[0])
		.filter((path): path is string => Boolean(path));
}

function leadScript(tag: string): AgentScript {
	return {
		name: "subagents-lead",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: (context) => {
			const { calls } = context;
			const started = calls.filter((call) => call.name === "agent");
			const applied = calls.filter(
				(call) =>
					call.name === "run_code" &&
					JSON.stringify(call.args).includes("git apply"),
			).length;
			const found = reports(context);
			if (!started.length)
				return {
					calls: [
						{
							name: "agent",
							args: {
								role: "writer",
								title: "Rehearsal writer",
								brief:
									'[rehearsal:writer] Add a one-line comment to the top of include/mvcc_lsm/types.h saying "rehearsal round 1". Run git diff --stat. Report the patch.',
							},
						},
						{
							name: "agent",
							args: {
								role: "researcher",
								title: "Rehearsal researcher",
								wait: true,
								brief:
									"[rehearsal:researcher] Report the working directory, your uid and what `make -n test` would run. Do not change anything.",
							},
						},
					],
				};
			if (found.length > applied) {
				const patch = found[applied];
				return runCode(`const apply = await tools.bash({ command: ${JSON.stringify(`git apply -3 ${patch} && git diff --stat && echo PATCH_APPLIED`)} });
return JSON.stringify(apply);`);
			}
			if (applied >= 1)
				return { text: `Rehearsal lead finished: ${applied} patches applied.` };
			// Waiting for the writer's report: Main hands off and ends its turn;
			// the report wakes it in a new turn, which applies the patch.
			return handOff();
		},
	};
}

function writerScript(name: string, tag: string): AgentScript {
	return {
		name,
		match: marked(tag),
		reply: ({ step }) => {
			if (step === 0)
				return runCode(`const before = await tools.bash({ command: "pwd; id -u; git log --oneline -3; git status --short" });
const path = "include/mvcc_lsm/types.h";
const text = await tools.read({ path });
const first = String(text).split("\\n")[0].replace(/^\\s*\\d+[\\t|:]\\s?/, "");
const edited = await tools.edit({ path, edits: [{ old_string: first, new_string: "// rehearsal round 1\\n" + first }] });
const after = await tools.bash({ command: "git diff --stat" });
return JSON.stringify({ before, edited, after });`);
			return {
				text: `Rehearsal ${name} round 1 done: one comment line added.`,
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

// ---------------------------------------------------------------------------
// c-c4. lead=fusion as Devin Fusion: the user's task, the sidekick's code
// exploration (started by the harness before the lead's first model call),
// file snippets, the lead's plan, the sidekick's code in the lead's own
// checkout while the lead waits, the lead's review in place, requested
// edits, fixes, the final answer after the last report.

/** Sidekick reports the lead received (each child event once). */
function writerReports(context: ScriptContext) {
	return context.userTexts.filter((text) =>
		/\[agent [\d.]+ writer (finished|failed|budget exhausted)/.test(text),
	);
}

const send = (args: Record<string, unknown>): Reply => ({
	calls: [{ name: "agent_send", args }],
});
const count = (context: ScriptContext, name: string) =>
	context.calls.filter((call) => call.name === name).length;
/** The lead's in-place reviews (run_code programs that print REVIEWED). */
const reviewCount = (context: ScriptContext) =>
	context.calls.filter(
		(call) =>
			call.name === "run_code" &&
			JSON.stringify(call.args).includes("REVIEWED"),
	).length;

/** The lead reviews a round in place: the report's diff command, then git status. */
function reviewInPlace(report: string): Reply {
	const diff = /`(git diff [0-9a-f]{7,40} [0-9a-f]{7,40})`/.exec(report)?.[1];
	const command = `${diff ?? "echo NO-ROUND-DIFF; git diff"} && git status --short && echo REVIEWED`;
	return runCode(`const review = await tools.bash({ command: ${JSON.stringify(command)} });
return JSON.stringify(review);`);
}

/** Main's hand-off text while its writer works: a status that ends its turn (the report wakes it). */
export const MAIN_HANDOFF = "MAIN_HANDOFF";
/** Main is free during a build round: it tells the user where things stand and ends its turn. */
const handOff = (): Reply => ({
	text: `${MAIN_HANDOFF}: my writer is working on the brief in my checkout; I review its report when it arrives.`,
});

/** A round that adds `// <marker>` above the first line of `path`. */
const markFile = (path: string, marker: string, before = "") =>
	runCode(`${before}const text = await tools.read({ path: ${JSON.stringify(path)} });
const first = String(text).split("\\n")[0].replace(/^\\s*\\d+[\\t|:]\\s?/, "");
const edited = await tools.edit({ path: ${JSON.stringify(path)}, edits: [{ old_string: first, new_string: ${JSON.stringify(`// ${marker}\n`)} + first }] });
const after = await tools.bash({ command: "pwd; id -u; test -e /.dockerenv && echo in-container; git diff --stat" });
return JSON.stringify({ edited, after });`);

export const EXPLORE_FILE = "include/mvcc_lsm/types.h";

/** The exploration round's program: reads, the check command, and where it runs. */
const EXPLORE_PROGRAM = `const [types, db, make] = await Promise.all([
  tools.read({ path: ${JSON.stringify(EXPLORE_FILE)}, limit: 12 }),
  tools.read({ path: "src/lsm_db.cc", limit: 10 }),
  tools.bash({ command: "pwd; id -u; test -e /.dockerenv && echo in-container; make -n test | head -3" }),
]);
const head = (text) => String(text).split("\\n").slice(0, 3).map((line) => line.replace(/^\\s*\\d+[\\t|:]\\s?/, "")).join("|");
return "SNIPPET_TYPES<<" + head(types) + ">> SNIPPET_DB<<" + head(db) + ">> WHERE<<" + JSON.stringify(make).replaceAll("\\n", " ") + ">>";`;

function explorationReport(last: ScriptContext["last"]) {
	// The program's return value, however the result is wrapped.
	const raw = (last[0]?.output ?? "").replaceAll('\\"', '"');
	const lines = (name: string) =>
		(new RegExp(`${name}<<(.*?)>>`).exec(raw)?.[1] ?? "").split("|");
	return [
		"Rehearsal exploration report.",
		"Files:",
		`- ${EXPLORE_FILE}:1-12: the engine's shared types`,
		"- src/lsm_db.cc:1-10: the DB entry point",
		"Snippets:",
		`${EXPLORE_FILE}:1-3`,
		...lines("SNIPPET_TYPES"),
		"src/lsm_db.cc:1-3",
		...lines("SNIPPET_DB"),
		"Commands:",
		"- make test: builds build/regression_test and runs it",
		`Where: ${(/WHERE<<(.*?)>>/.exec(raw)?.[1] ?? "").slice(0, 300)}`,
		"Open questions:",
		"- none",
	].join("\n");
}

type Round =
	| { readonly kind: "explore" }
	| {
			readonly kind: "build";
			readonly path: string;
			readonly marker: string;
			/** A check run first (its failure is the stuck signal's evidence). */
			readonly check?: string;
	  };

/**
 * A sidekick: its conversation starts with the harness's exploration brief
 * for the scenario's request; each round is a program step and a report.
 */
function sidekickScript(
	name: string,
	tag: string,
	rounds: Round[],
): AgentScript {
	return {
		name,
		match: (first) =>
			first.includes(HARNESS_EXPLORE_HEADING) &&
			first.includes(tag) &&
			!isClassifier(first),
		reply: ({ step, last }) => {
			const index = Math.floor(step / 2);
			const round = rounds[index];
			if (!round) return { text: `Rehearsal ${name}: no round ${index + 1}.` };
			if (step % 2 === 0)
				return round.kind === "explore"
					? runCode(EXPLORE_PROGRAM)
					: markFile(
							round.path,
							round.marker,
							round.check
								? `const check = await tools.bash({ command: ${JSON.stringify(round.check)} });\n`
								: "",
						);
			if (round.kind === "explore") return { text: explorationReport(last) };
			return {
				text: round.check
					? `Rehearsal ${name} round ${index + 1}: ${round.check} still fails; marked ${round.path}.`
					: `Rehearsal ${name} round ${index + 1} done: marked ${round.path} with "${round.marker}".`,
			};
		},
	};
}

/** A lead's conversation (the scenario's task), never a sidekick's or a checker's. */
const leadMatch = (tag: string) => (first: string) =>
	first.includes(tag) &&
	!isChecker(first) &&
	!first.includes(HARNESS_EXPLORE_HEADING) &&
	!isClassifier(first);

/** The write the lead tries in the same batch as a handoff (the guard refuses it). */
const LEAD_WRITE_PROBE = `const edited = await tools.edit({ path: "src/version_set.cc", edits: [{ old_string: "#include", new_string: "// lead write during a round\\n#include" }] });
return JSON.stringify({ edited });`;

/**
 * c: harness exploration, a planned build round, an in-place review,
 * requested edits (sent with a write the guard refuses), the fix round,
 * a second review, the final answer.
 */
function fusionLeadScript(tag: string): AgentScript {
	return {
		name: "fusion-lead",
		match: leadMatch(tag),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const sends = count(context, "agent_send");
			const reviews = reviewCount(context);
			if (!reportsIn.length)
				return {
					text: "NO_EXPLORATION_REPORT: the lead's first request had no snippets.",
				};
			if (reportsIn.length < sends + 1) return handOff();
			if (!sends)
				return send({
					id: "1",
					message: `[rehearsal:fusion-build] Plan from your snippets: add the line "// rehearsal round 2" above line 1 of ${EXPLORE_FILE}, then run git diff --stat and report.`,
				});
			if (reviews < sends) return reviewInPlace(reportsIn.at(-1) as string);
			if (sends === 1)
				return {
					calls: [
						{
							name: "agent_send",
							args: {
								id: "1",
								message:
									'[rehearsal:fusion-feedback] Reviewed. Also add "// rehearsal round 3" above line 1 of src/lsm_db.cc and report.',
							},
						},
						{ name: "run_code", args: { code: LEAD_WRITE_PROBE } },
					],
				};
			return {
				text: "Rehearsal lead finished: two build rounds reviewed in place.",
			};
		},
	};
}

/** c2: the lead plans from the harness exploration's snippets without reading. */
/** The explore lead's requirements list (rigor=on). */
export const LEAD_REQUIREMENTS = [
	`${REQUIREMENTS_MARK}: ${EXPLORE_FILE} starts with the rehearsal explore line`,
];

function exploreLeadScript(tag: string): AgentScript {
	return {
		name: "explore-lead",
		match: leadMatch(tag),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const sends = count(context, "agent_send");
			if (!reportsIn.length)
				return {
					text: "NO_EXPLORATION_REPORT: the lead's first request had no snippets.",
				};
			if (reportsIn.length < sends + 1) return handOff();
			if (!sends) {
				// The plan quotes the sidekick's snippet: the lead never read the file.
				const snippet =
					/Snippets:\n[^\n]*\n([^\n]+)/.exec(reportsIn[0] ?? "")?.[1] ?? "";
				return {
					...send({
						id: "1",
						message: `[rehearsal:explore-build] Plan from your snippets: above "${snippet.trim()}" (line 1 of ${EXPLORE_FILE}) add the line "// rehearsal explore build", then run git diff --stat and report.\nRequirements:\n- ${LEAD_REQUIREMENTS[0]}`,
					}),
					// rigor=on: the list right after the exploration report.
					text: requirementsMessage(LEAD_REQUIREMENTS),
				};
			}
			if (reviewCount(context) < sends)
				return reviewInPlace(reportsIn.at(-1) as string);
			return { text: "Rehearsal explore lead finished." };
		},
	};
}

export const MULTITURN_FOLLOW_UP =
	"[rehearsal:fusion-multiturn-2] A second request in the same chat: also mark src/lsm_db.cc.";

/** c3: the same sidekick serves the chat's second user message, exploring it first. */
function multiturnLeadScript(tag: string): AgentScript {
	return {
		name: "multiturn-lead",
		match: leadMatch(tag),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const sends = context.calls.filter((call) => call.name === "agent_send");
			const builds = sends.filter(
				(call) => !(call.args as { stop?: boolean }).stop,
			).length;
			const second = context.userTexts.some((text) =>
				text.includes("[rehearsal:fusion-multiturn-2]"),
			);
			// Rounds so far: one exploration per request, one build per send.
			const expected = (second ? 2 : 1) + builds;
			if (reportsIn.length < expected) return handOff();
			if (reviewCount(context) < builds)
				return reviewInPlace(reportsIn.at(-1) as string);
			if (!second)
				return builds
					? { text: "First request done; the sidekick stays for the chat." }
					: send({
							id: "1",
							message: `[rehearsal:mt-build-1] Add "// rehearsal round 2" above line 1 of ${EXPLORE_FILE} and report.`,
						});
			if (builds < 2)
				return send({
					id: "1",
					message:
						'[rehearsal:mt-build-2] The user\'s next request: add "// rehearsal round 4" above line 1 of src/lsm_db.cc and report.',
				});
			if (sends.length < 3) return send({ id: "1", stop: true });
			return { text: "Second request done; sidekick stopped." };
		},
	};
}

/** c4: the sidekick fails the same check twice; the lead is told, then the runtime switches models. */
function stuckLeadScript(tag: string): AgentScript {
	return {
		name: "stuck-lead",
		match: leadMatch(tag),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const sends = count(context, "agent_send");
			const reviews = reviewCount(context);
			if (reportsIn.length < sends + 1) return handOff();
			if (reviews < sends) return reviewInPlace(reportsIn.at(-1) as string);
			if (sends === 0)
				return send({
					id: "1",
					message: `[rehearsal:stuck-build] Make \`make bogus-check\` pass, and add "// rehearsal stuck 1" above line 1 of ${EXPLORE_FILE}. Report.`,
				});
			if (sends === 1)
				return send({
					id: "1",
					message:
						'[rehearsal:stuck-feedback] make bogus-check still fails. Fix it, and add "rehearsal stuck 2" to the top of src/lsm_db.cc.',
				});
			if (sends === 2)
				return send({
					id: "1",
					message:
						'[rehearsal:stuck-escalated] Add a one-line comment "rehearsal escalated" to the top of src/snapshot_context.cc and report.',
				});
			return { text: "Rehearsal stuck lead finished." };
		},
	};
}

/** c4: the same sidekick session, now on the escalation model after its compaction. */
function escalatedSidekickScript(): AgentScript {
	return {
		name: "escalated-sidekick",
		match: (first, model) =>
			first.includes("[rehearsal:stuck-escalated]") &&
			!isClassifier(first) &&
			model === "gpt-6.1-sol",
		reply: ({ calls }) =>
			calls.some((call) =>
				JSON.stringify(call.args).includes("rehearsal escalated"),
			)
				? { text: "Rehearsal escalated sidekick done." }
				: markFile("src/snapshot_context.cc", "rehearsal escalated"),
	};
}

/** c5: the classifier hands the build round back; the lead takes over and edits itself. */
function handbackLeadScript(tag: string): AgentScript {
	return {
		name: "handback-lead",
		match: leadMatch(tag),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const sends = count(context, "agent_send");
			if (!reportsIn.length)
				return {
					text: "NO_EXPLORATION_REPORT: the lead's first request had no snippets.",
				};
			if (reportsIn.length < sends + 1) return handOff();
			if (!sends)
				return send({
					id: "1",
					message: `[rehearsal:handback-build] Add "// rehearsal handback 1" above line 1 of ${EXPLORE_FILE} and report.`,
				});
			if (reviewCount(context) < sends)
				return reviewInPlace(reportsIn.at(-1) as string);
			const handedBack = context.userTexts.some((text) =>
				text.includes("Runtime notice: writer 1 needs you"),
			);
			if (!handedBack) return { text: "NO_HANDBACK_NOTICE" };
			if (!leadEdited(context))
				return runCode(`const text = await tools.read({ path: "src/lsm_db.cc" });
const first = String(text).split("\\n")[0].replace(/^\\s*\\d+[\\t|:]\\s?/, "");
const edited = await tools.edit({ path: "src/lsm_db.cc", edits: [{ old_string: first, new_string: "// rehearsal lead took over\\n" + first }] });
return JSON.stringify({ edited, LEAD_TOOK_OVER: true });`);
			return { text: "Rehearsal handback lead took over and finished." };
		},
	};
}

const leadEdited = (context: ScriptContext) =>
	context.calls.some((call) =>
		JSON.stringify(call.args).includes("LEAD_TOOK_OVER"),
	);

/** c6: the classifier answers prose; the rules decide (no escalation model: hand back). */
function classifierFailLeadScript(tag: string): AgentScript {
	return {
		name: "clsfail-lead",
		match: leadMatch(tag),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const sends = count(context, "agent_send");
			if (!reportsIn.length)
				return {
					text: "NO_EXPLORATION_REPORT: the lead's first request had no snippets.",
				};
			if (reportsIn.length < sends + 1) return handOff();
			if (reviewCount(context) < sends)
				return reviewInPlace(reportsIn.at(-1) as string);
			if (sends === 0)
				return send({
					id: "1",
					message: `[rehearsal:clsfail-build] Make \`make bogus-check\` pass, and add "// rehearsal stuck 1" above line 1 of ${EXPLORE_FILE}. Report.`,
				});
			if (sends === 1)
				return send({
					id: "1",
					message:
						'[rehearsal:clsfail-feedback] make bogus-check still fails. Fix it, and add "rehearsal stuck 2" to the top of src/lsm_db.cc.',
				});
			return { text: "Rehearsal classifier-failure lead finished." };
		},
	};
}

/**
 * The classifier, scripted per scenario by the brief's marker: c4 says
 * switch_model after the second failing build round (the lead's feedback
 * brief); c5 hands the build round back; c6 answers prose (unparsable, so the rules decide); any other
 * sidekick round is on_track.
 */
export function classifierScript(): AgentScript {
	return {
		name: "classifier",
		match: isClassifier,
		reply: ({ userTexts }) => {
			const text = userTexts.join("\n");
			const summary = JSON.parse(
				text.slice(text.indexOf(CLASSIFIER_MARKER) + CLASSIFIER_MARKER.length),
			) as { round: number; brief: string; canSwitch: boolean };
			const json = (decision: string, reason: string) => ({
				text: JSON.stringify({ decision, reason }),
			});
			if (summary.brief.includes("[rehearsal:stuck-"))
				return summary.brief.includes("[rehearsal:stuck-feedback]")
					? json(
							"switch_model",
							"rehearsal: it failed make bogus-check twice the same way",
						)
					: json("on_track", "rehearsal: progressing");
			if (summary.brief.includes("[rehearsal:handback-"))
				return json(
					"hand_back",
					"rehearsal: the brief leaves src/lsm_db.cc to the lead",
				);
			if (summary.brief.includes("[rehearsal:clsfail-"))
				return { text: "Looks stuck to me, probably." };
			return json("on_track", "rehearsal: progressing");
		},
	};
}

// ---------------------------------------------------------------------------
// e. rigor=on with outputCap=10000 at effort high: a long command output is
// capped with a hint; the builder edits and finishes admitting an unverified
// path; the checker (another model, no effort of its own) passes, and the
// review loop sends the admission back; the builder verifies and round 2
// passes.

export const RIGOR_BLOCK = "Ambiguous wording: list the plausible readings";
export const RIGOR_CHECKER_LINES = [
	"assumptions or interpretations it states",
	"Run it once as an outside user would",
	"A deliverable that itself admits unverified, failing or skipped parts",
];
export const ADMITTED_LINE =
	"Unverified: the compaction path under concurrent writers was not tested.";
export const CAP_NOTE = "cut from the middle of this";

function rigorBuilderScript(tag: string): AgentScript {
	return {
		name: "rigor-builder",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: ({ step, userTexts, calls }) => {
			if (step === 0)
				return {
					...bash("seq 1 30000"),
					text: requirementsMessage(BUILDER_REQUIREMENTS),
				};
			if (step === 1) return { calls: [{ name: "edit", args: builderEdit }] };
			const notices = userTexts.filter((text) => text.includes(NOTICE));
			if (!notices.length)
				return { text: `Rehearsal rigor change made.\n${ADMITTED_LINE}` };
			if (!calls.some((call) => JSON.stringify(call.args).includes("verified")))
				return {
					calls: [
						{
							name: "edit",
							args: {
								path: TEST_FILE,
								edits: [
									{
										old_string: '"rehearsal edit applied\\n"',
										new_string: '"rehearsal edit applied (verified)\\n"',
									},
								],
							},
						},
					],
				};
			return {
				text: "Verified the concurrent-writer path.\nF1: fixed\nUnverified: none.",
			};
		},
	};
}

function rigorCheckerScript(tag: string): AgentScript {
	return {
		name: "rigor-checker",
		match: (first) => isChecker(first) && first.includes(tag),
		reply: () => ({
			text: JSON.stringify({
				verdict: "pass",
				failures: [],
				tests: [
					{
						name: "rehearsal: the edit is present",
						command:
							"grep -c 'rehearsal edit applied' tests/regression_test.cc",
						passed: true,
						output: "1",
					},
				],
				requirements: [],
				assumptions: [],
				notes: "rehearsal rigor check",
			}),
		}),
	};
}

/** fusion-explore's review: a checker that passes with one test of its own. */
function exploreCheckerScript(tag: string): AgentScript {
	return {
		name: "explore-checker",
		match: (first) => isChecker(first) && first.includes(tag),
		reply: () => ({
			text: JSON.stringify({
				verdict: "pass",
				failures: [],
				tests: [
					{
						name: "rehearsal: the explore line is present",
						command: `grep -c 'rehearsal explore build' ${EXPLORE_FILE}`,
						passed: true,
						output: "1",
					},
				],
				requirements: [],
				assumptions: [],
				notes: "rehearsal explore check",
			}),
		}),
	};
}

// ---------------------------------------------------------------------------
// f. fork at a message: turn 1 writes a marker file, turn 2 rewrites it; the
// chat is forked at message 2, whose code point holds turn 1's marker. The
// fork's own VM (a copy of the chat's) must show turn 1's marker on the
// fork's branch while the chat keeps turn 2's, and a turn in the fork reads
// turn 1's marker.

export const FORK_MARKER = "fork-marker.txt";
export const FORK_FOLLOW_UP =
	"[rehearsal:fork-2] A second request: rewrite the marker.";
/** Questions answered without tools: their turns take no code point. */
export const FORK_QUESTION = (n: number) =>
	`[rehearsal:fork-qa${n}] Just answer: what is the marker for?`;
export const FORK_IN_FORK = "[rehearsal:fork-3] In the fork: show the marker.";

function forkBuilderScript(tag: string): AgentScript {
	return {
		name: "fork-builder",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: ({ userTexts, calls }) => {
			const ran = (needle: string) =>
				calls.some((call) => JSON.stringify(call.args).includes(needle));
			// The newest request decides; earlier ones are history.
			const latest =
				[...userTexts]
					.reverse()
					.find((text) => text.includes("[rehearsal:fork")) ?? "";
			if (latest.includes("[rehearsal:fork-3]"))
				return ran(`cat ${FORK_MARKER}`)
					? { text: "Marker shown in the fork." }
					: bash(`cat ${FORK_MARKER}`);
			if (latest.includes("[rehearsal:fork-qa"))
				return { text: "It marks which turn's code this is." };
			if (latest.includes("[rehearsal:fork-2]"))
				return ran("fork two")
					? { text: "Marker rewritten." }
					: bash(`printf 'fork two\\n' > ${FORK_MARKER} && echo WROTE`);
			return ran("fork one")
				? { text: "Marker written." }
				: bash(`printf 'fork one\\n' > ${FORK_MARKER} && echo WROTE`);
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
			memory: REHEARSAL_MEMORY,
		},
		{
			id: "review-pair",
			title:
				"b2. review=on, checkerMode=pair: a Sol judge briefs a Luna worker, which copies, tests and runs make test as the reader; the judge's verdict, costs split, both rounds full",
			variant:
				"codeMode=primary,subagents=on,review=on,checkerMode=pair,roleModels.checker=codex:gpt-6.1-sol,roleModels.checkerWorker=codex:gpt-6-luna",
			scripts: [
				reviewBuilderScript("[rehearsal:review-pair]", "pair-builder"),
				pairJudgeScript("[rehearsal:review-pair]"),
				pairWorkerScript(),
			],
		},
		{
			id: "fusion",
			title:
				"c. lead=fusion: harness exploration, two build rounds in the lead's checkout, Main hands off and reviews in place",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				fusionLeadScript("[rehearsal:fusion]"),
				sidekickScript("sidekick", "[rehearsal:fusion]", [
					{ kind: "explore" },
					{ kind: "build", path: EXPLORE_FILE, marker: "rehearsal round 2" },
					{ kind: "build", path: "src/lsm_db.cc", marker: "rehearsal round 3" },
				]),
			],
		},
		{
			id: "fusion-explore",
			title:
				"c2. lead=fusion explore-first, rigor=on, review=on: the harness's exploration round returns snippets, the lead writes its requirements list and plans from them without reading; the checker gets the list",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,review=on,rigor=on,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				exploreLeadScript("[rehearsal:fusion-explore]"),
				exploreCheckerScript("[rehearsal:fusion-explore]"),
				sidekickScript("explore-sidekick", "[rehearsal:fusion-explore]", [
					{ kind: "explore" },
					{
						kind: "build",
						path: EXPLORE_FILE,
						marker: "rehearsal explore build",
					},
				]),
			],
		},
		{
			id: "fusion-multiturn",
			title:
				"c3. lead=fusion multi-turn: the chat's second message is explored by, and built on, the same sidekick session",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				multiturnLeadScript("[rehearsal:fusion-multiturn]"),
				sidekickScript("mt-sidekick", "[rehearsal:fusion-multiturn]", [
					{ kind: "explore" },
					{ kind: "build", path: EXPLORE_FILE, marker: "rehearsal round 2" },
					{ kind: "explore" },
					{ kind: "build", path: "src/lsm_db.cc", marker: "rehearsal round 4" },
				]),
			],
			followUps: [MULTITURN_FOLLOW_UP],
		},
		{
			id: "fusion-stuck",
			title:
				"c4. lead=fusion classifier switch: the same check fails twice, the classifier says switch_model, the same sidekick continues on writerEscalation after its compaction",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna,roleModels.writerEscalation=codex:gpt-6.1-sol",
			scripts: [
				// First: after its compaction the escalated sidekick's history keeps the request's tag.
				escalatedSidekickScript(),
				stuckLeadScript("[rehearsal:fusion-stuck]"),
				sidekickScript("stuck-sidekick", "[rehearsal:fusion-stuck]", [
					{ kind: "explore" },
					{
						kind: "build",
						path: EXPLORE_FILE,
						marker: "rehearsal stuck 1",
						check: "make bogus-check",
					},
					{
						kind: "build",
						path: "src/lsm_db.cc",
						marker: "rehearsal stuck 2",
						check: "make bogus-check",
					},
				]),
			],
		},
		{
			id: "fusion-handback",
			title:
				"c5. lead=fusion hand_back: the classifier hands the build round back, the notice reaches the lead, which takes over",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna,roleModels.writerEscalation=codex:gpt-6.1-sol",
			scripts: [
				handbackLeadScript("[rehearsal:fusion-handback]"),
				sidekickScript("handback-sidekick", "[rehearsal:fusion-handback]", [
					{ kind: "explore" },
					{ kind: "build", path: EXPLORE_FILE, marker: "rehearsal handback 1" },
				]),
			],
		},
		{
			id: "fusion-classifier-fail",
			title:
				"c6. lead=fusion classifier failure: an unparsable answer falls back to the rules, which hand the stuck round back",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				classifierFailLeadScript("[rehearsal:fusion-classifier-fail]"),
				sidekickScript(
					"clsfail-sidekick",
					"[rehearsal:fusion-classifier-fail]",
					[
						{ kind: "explore" },
						{
							kind: "build",
							path: EXPLORE_FILE,
							marker: "rehearsal stuck 1",
							check: "make bogus-check",
						},
						{
							kind: "build",
							path: "src/lsm_db.cc",
							marker: "rehearsal stuck 2",
							check: "make bogus-check",
						},
					],
				),
			],
		},
		{
			id: "subagents",
			title: "d. subagents=on: a researcher in the container, a writer's patch",
			variant: "codeMode=primary,subagents=on",
			scripts: [
				leadScript("[rehearsal:subagents]"),
				writerScript("writer", "[rehearsal:writer]"),
				researcherScript(),
			],
			memory: REHEARSAL_MEMORY,
		},
		{
			id: "rigor",
			title:
				"e. rigor=on, outputCap=10000, effort high: capped output, rigor prompts, an admitted gap sent back, the checker inherits the effort",
			variant:
				"subagents=on,review=on,rigor=on,outputCap=10000,roleModels.checker=codex:gpt-6-luna",
			reasoning: "high",
			scripts: [
				rigorBuilderScript("[rehearsal:rigor]"),
				rigorCheckerScript("[rehearsal:rigor]"),
			],
		},
		{
			id: "fork",
			title:
				"f. fork at a message: the fork's VM is a copy of the chat's at that message's code, on its own branch; the chat is unchanged",
			variant: "codeMode=primary",
			scripts: [forkBuilderScript("[rehearsal:fork]")],
			// 1 writes "fork one", 2 asks, 3 writes "fork two", 4 asks.
			followUps: [FORK_QUESTION(1), FORK_FOLLOW_UP, FORK_QUESTION(2)],
			forkAt: 3,
			qaForks: [
				{ at: 2, marker: "fork one\n" },
				{ at: 4, marker: "fork two\n" },
			],
		},
	];
}
