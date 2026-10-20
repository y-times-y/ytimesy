// Rehearsal scenarios: what each scripted agent does, and what must be
// observable afterwards. Every agent's conversation is told apart by a
// marker in its first message: the task text carries [rehearsal:<id>], and
// the scripted leads write [rehearsal:<role>] into their briefs.
import type { AgentScript, Reply, ScriptContext } from "./fake-codex";

export type Check = { name: string; ok: boolean; detail?: string };

export type ScenarioId =
	| "builder"
	| "review"
	| "fusion"
	| "fusion-explore"
	| "fusion-multiturn"
	| "fusion-stuck"
	| "subagents"
	| "rigor";

export type Scenario = {
	readonly id: ScenarioId;
	readonly title: string;
	readonly variant: string;
	/** The chat's reasoning effort (the model's default when unset). */
	readonly reasoning?: string;
	readonly scripts: AgentScript[];
	/** Later user messages, each sent once the chat settled after the one before. */
	readonly followUps?: readonly string[];
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

// ---------------------------------------------------------------------------
// c2-c4. lead=fusion as Devin Fusion: exploration first, a sidekick that
// lives across the chat's messages, and stuck signals with a model switch.

/** Sidekick reports the lead received (each child event once). */
function writerReports(context: ScriptContext) {
	return context.userTexts.filter((text) =>
		/\[agent [\d.]+ writer (finished|failed|budget exhausted)/.test(text),
	);
}

const applyPatch = (patch: string) =>
	runCode(`const apply = await tools.bash({ command: ${JSON.stringify(`git apply -3 ${patch} && git diff --stat && echo PATCH_APPLIED`)} });
return JSON.stringify(apply);`);
const waitForReport = () => bash("sleep 15; echo waiting-for-report");
const send = (args: Record<string, unknown>): Reply => ({
	calls: [{ name: "agent_send", args }],
});
const count = (context: ScriptContext, name: string) =>
	context.calls.filter((call) => call.name === name).length;
const appliedCount = (context: ScriptContext) =>
	context.calls.filter(
		(call) =>
			call.name === "run_code" &&
			JSON.stringify(call.args).includes("git apply"),
	).length;

/** A round that adds `// <marker>` above the first line of `path`. */
const markFile = (path: string, marker: string, before = "") =>
	runCode(`${before}const text = await tools.read({ path: ${JSON.stringify(path)} });
const first = String(text).split("\\n")[0].replace(/^\\s*\\d+[\\t|:]\\s?/, "");
const edited = await tools.edit({ path: ${JSON.stringify(path)}, edits: [{ old_string: first, new_string: ${JSON.stringify(`// ${marker}\n`)} + first }] });
const after = await tools.bash({ command: "git diff --stat" });
return JSON.stringify({ edited, after });`);

export const EXPLORE_FILE = "include/mvcc_lsm/types.h";

/** c2: the lead's first handoff is exploration; it plans from the snippets. */
function exploreLeadScript(tag: string): AgentScript {
	return {
		name: "explore-lead",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const applied = appliedCount(context);
			if (!count(context, "agent"))
				return {
					calls: [
						{
							name: "agent",
							args: {
								role: "writer",
								title: "Explore the storage engine",
								explore: true,
								brief:
									"[rehearsal:explore-sidekick] Find and return the code this task touches: the type definitions and the DB entry point, with file paths, the key snippets and line ranges, how to run the checks, and what the task touches.",
							},
						},
					],
				};
			if (!reportsIn.length) return waitForReport();
			if (!count(context, "agent_send")) {
				// The plan quotes the sidekick's snippet: the lead never read the file.
				const snippet =
					/Snippets:\n[^\n]*\n([^\n]+)/.exec(reportsIn[0] ?? "")?.[1] ?? "";
				return send({
					id: "1",
					message: `[rehearsal:explore-build] Plan from your snippets: above "${snippet.trim()}" (line 1 of ${EXPLORE_FILE}) add the line "// rehearsal explore build", then run git diff --stat and report the patch.`,
				});
			}
			const patches = reports(context);
			if (patches.length > applied)
				return applyPatch(patches[applied] as string);
			if (applied) return { text: "Rehearsal explore lead finished." };
			return waitForReport();
		},
	};
}

function exploreSidekickScript(): AgentScript {
	return {
		name: "explore-sidekick",
		match: marked("[rehearsal:explore-sidekick]"),
		reply: ({ step, last }) => {
			if (step === 0)
				return runCode(`const [types, db, make] = await Promise.all([
  tools.read({ path: ${JSON.stringify(EXPLORE_FILE)}, limit: 12 }),
  tools.read({ path: "src/lsm_db.cc", limit: 10 }),
  tools.bash({ command: "make -n test | head -3" }),
]);
const head = (text) => String(text).split("\\n").slice(0, 3).map((line) => line.replace(/^\\s*\\d+[\\t|:]\\s?/, "")).join("|");
return "SNIPPET_TYPES<<" + head(types) + ">> SNIPPET_DB<<" + head(db) + ">> MAKE_EXIT=" + make.exitCode;`);
			if (step === 1) {
				// The program's return value, however the result is wrapped.
				const raw = (last[0]?.output ?? "").replaceAll('\\"', '"');
				const lines = (name: string) =>
					(new RegExp(`${name}<<(.*?)>>`).exec(raw)?.[1] ?? "").split("|");
				return {
					text: [
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
						"Open questions:",
						"- none",
					].join("\n"),
				};
			}
			if (step === 2) return markFile(EXPLORE_FILE, "rehearsal explore build");
			return { text: "Rehearsal explore-sidekick build round done." };
		},
	};
}

export const MULTITURN_FOLLOW_UP =
	"[rehearsal:fusion-multiturn-2] A second request in the same chat: also mark src/lsm_db.cc.";

/** c3: the same sidekick serves the chat's second user message. */
function multiturnLeadScript(tag: string): AgentScript {
	return {
		name: "multiturn-lead",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const applied = appliedCount(context);
			const patches = reports(context);
			const second = context.userTexts.some((text) =>
				text.includes("[rehearsal:fusion-multiturn-2]"),
			);
			if (!count(context, "agent"))
				return {
					calls: [
						{
							name: "agent",
							args: {
								role: "writer",
								title: "Mark the types",
								brief: `[rehearsal:mt-sidekick] Add a one-line comment "rehearsal round 1" to the top of ${EXPLORE_FILE}. Run git diff --stat. Report the patch.`,
							},
						},
					],
				};
			if (patches.length > applied)
				return applyPatch(patches[applied] as string);
			if (!second)
				return applied
					? { text: "First request done; the sidekick stays for the chat." }
					: waitForReport();
			const sends = context.calls.filter((call) => call.name === "agent_send");
			if (!sends.length)
				return send({
					id: "1",
					message:
						'[rehearsal:mt-feedback] The user\'s next request: add a one-line comment "rehearsal round 2" to the top of src/lsm_db.cc and report the patch.',
				});
			if (reportsIn.length < 2 || applied < 2) return waitForReport();
			if (sends.length < 2) return send({ id: "1", stop: true });
			return { text: "Second request done; sidekick stopped." };
		},
	};
}

/** c4: the sidekick fails the same check twice; the lead is told, then the runtime switches models. */
function stuckLeadScript(tag: string): AgentScript {
	return {
		name: "stuck-lead",
		match: (first) => first.includes(tag) && !isChecker(first),
		reply: (context) => {
			const reportsIn = writerReports(context);
			const applied = appliedCount(context);
			const patches = reports(context);
			const sends = count(context, "agent_send");
			if (!count(context, "agent"))
				return {
					calls: [
						{
							name: "agent",
							args: {
								role: "writer",
								title: "Make the bogus check pass",
								brief: `[rehearsal:stuck-sidekick] Make \`make bogus-check\` pass, and add a one-line comment "rehearsal stuck 1" to the top of ${EXPLORE_FILE}. Report the patch.`,
							},
						},
					],
				};
			if (patches.length > applied)
				return applyPatch(patches[applied] as string);
			if (reportsIn.length === 1 && sends === 0)
				return send({
					id: "1",
					message:
						'[rehearsal:stuck-feedback] make bogus-check still fails. Fix it, and add "rehearsal stuck 2" to the top of src/lsm_db.cc.',
				});
			if (reportsIn.length === 2 && sends === 1)
				return send({
					id: "1",
					message:
						'[rehearsal:escalated] Add a one-line comment "rehearsal escalated" to the top of src/snapshot_context.cc and report the patch.',
				});
			if (reportsIn.length >= 3 && applied >= 3)
				return { text: "Rehearsal stuck lead finished." };
			return waitForReport();
		},
	};
}

function stuckSidekickScript(): AgentScript {
	const files = [EXPLORE_FILE, "src/lsm_db.cc"];
	return {
		name: "stuck-sidekick",
		match: (first) =>
			first.includes("[rehearsal:stuck-sidekick]") &&
			!first.includes("You take over as the lead's sidekick"),
		reply: ({ step }) => {
			const round = Math.floor(step / 2);
			if (step % 2 === 0)
				return markFile(
					files[round] ?? EXPLORE_FILE,
					`rehearsal stuck ${round + 1}`,
					'const check = await tools.bash({ command: "make bogus-check" });\n',
				);
			return {
				text: `Rehearsal stuck sidekick round ${round + 1}: make bogus-check still fails.`,
			};
		},
	};
}

function escalatedSidekickScript(): AgentScript {
	return {
		name: "escalated-sidekick",
		match: (first) =>
			first.includes("You take over as the lead's sidekick") &&
			first.includes("[rehearsal:escalated]"),
		reply: ({ step }) =>
			step === 0
				? markFile("src/snapshot_context.cc", "rehearsal escalated")
				: { text: "Rehearsal escalated sidekick done." },
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
			if (step === 0) return bash("seq 1 30000");
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
			id: "fusion-explore",
			title:
				"c2. lead=fusion explore-first: round 1 returns snippets, the lead plans from them without reading",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				exploreLeadScript("[rehearsal:fusion-explore]"),
				exploreSidekickScript(),
			],
		},
		{
			id: "fusion-multiturn",
			title:
				"c3. lead=fusion multi-turn: the chat's second message reuses the same sidekick session and fork",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna",
			scripts: [
				multiturnLeadScript("[rehearsal:fusion-multiturn]"),
				writerScript("mt-sidekick", "[rehearsal:mt-sidekick]"),
			],
			followUps: [MULTITURN_FOLLOW_UP],
		},
		{
			id: "fusion-stuck",
			title:
				"c4. lead=fusion stuck signal: the same check fails twice, the lead is told, the sidekick restarts on writerEscalation",
			variant:
				"codeMode=primary,subagents=on,lead=fusion,roleModels.writer=codex:gpt-6-luna,roleModels.writerEscalation=codex:gpt-6.1-sol",
			scripts: [
				stuckLeadScript("[rehearsal:fusion-stuck]"),
				escalatedSidekickScript(),
				stuckSidekickScript(),
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
	];
}
