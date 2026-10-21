// What a rehearsal scenario left behind (turn items, child sessions, model
// requests, VM state) and the checks each scenario must pass.

import {
	MEMORY_DIRECTORY,
	MEMORY_PROJECT_RULES_HEADER,
} from "../../src/domain/memory-repo";
import type { ReviewLoopState } from "../../src/domain/review-loop";
import {
	fusionTurnMetrics,
	HARNESS_EXPLORE_HEADING,
	type SidekickState,
} from "../../src/domain/sidekick";
import type { SubagentBudget } from "../../src/domain/subagent";
import { database } from "../../src/server/adapters/database";
import { stageScript, type TaskEnvironment } from "../hard-set/environment";
import type { RehearsalEdge } from "./edge";
import type { FakeCodex, ModelRequestRecord } from "./fake-codex";
import {
	ADMITTED_LINE,
	BUILDER_LIST_LABEL,
	BUILDER_REQUIREMENTS,
	CAP_NOTE,
	CHECKER_MARKER,
	type Check,
	EXPLORE_FILE,
	LEAD_REQUIREMENTS,
	LEAD_REQUIREMENTS_INSTRUCTION,
	MEMORY_RULE,
	MULTITURN_FOLLOW_UP,
	PAIR_WORKER_MARKER,
	PAIR_WORKER_TAG,
	REQUIREMENTS_INSTRUCTION,
	REQUIREMENTS_MARK,
	RIGOR_BLOCK,
	RIGOR_CHECKER_LINES,
	type ScenarioId,
} from "./scenarios";
import type { RehearsalVms } from "./vm";

type Item = {
	id?: string;
	kind: string;
	tool?: string;
	text?: string;
	input?: string;
	output?: string;
	status?: string;
	message?: string;
};

export type Collected = Awaited<ReturnType<typeof collect>>;

export async function collect(input: {
	sessionId: string;
	userId: string;
	vm: string;
	vms: RehearsalVms;
	fake: FakeCodex;
	edge: RehearsalEdge;
}) {
	const db = database();
	const turns = async (sessionId: string) =>
		(
			await db.query<{ id: string; state: string; items: Item[] }>(
				"select id,state,items from api_turn where session_id=$1 order by created_at",
				[sessionId],
			)
		).rows;
	const session = (
		await db.query<{
			items: Item[];
			listed_model_id: string | null;
			harness: string;
		}>("select items,listed_model_id,harness from agent_session where id=$1", [
			input.sessionId,
		])
	).rows[0];
	const children = (
		await db.query<{
			id: string;
			parent_session_id: string;
			agent_role: string | null;
			title: string;
			task_state: string | null;
			task_placement: string | null;
			task_access: string | null;
			provider_ref: string | null;
			agent_fork: Record<string, unknown> | null;
			agent_budget: (SubagentBudget & { sidekick?: SidekickState }) | null;
			listed_model_id: string | null;
			harness: string;
			items: Item[];
		}>(
			`with recursive tree as (select id from agent_session where id=$1
			 union all select s.id from agent_session s join tree t on s.parent_session_id=t.id)
			 select id,parent_session_id,agent_role,title,task_state,task_placement,task_access,provider_ref,agent_fork,agent_budget,listed_model_id,harness,items
			 from agent_session where id in (select id from tree) and id<>$1 order by created_at`,
			[input.sessionId],
		)
	).rows;
	const childTurns = Object.fromEntries(
		await Promise.all(
			children.map(async (child) => [child.id, await turns(child.id)] as const),
		),
	);
	const reviewState = (
		await db.query<{ request_id: string; response: unknown }>(
			"select request_id,response from agent_task_command_receipt where parent_session_id=$1 and request_id like '%review%' order by updated_at",
			[input.sessionId],
		)
	).rows;
	return {
		sessionId: input.sessionId,
		rootTurns: await turns(input.sessionId),
		rootItems: session?.items ?? [],
		rootModel: session?.listed_model_id ?? null,
		rootHarness: session?.harness ?? "codex",
		children,
		childTurns,
		reviewState,
		requests: input.fake.requests,
		faults: input.fake.faultsSent,
		forks: input.vms.forks,
		destroyed: input.vms.destroyed,
		edgeErrors: input.edge.errors,
		// One edge serves every scenario; each has its own user.
		memoryJobs: input.edge.memoryJobs.filter(
			(job) => job.userId === input.userId,
		),
	};
}

type CodeOutput = {
	ok?: boolean;
	result?: string;
	calls?: { tool: string; status: string; output: string }[];
};

function parseOutput(item: Item | undefined): CodeOutput {
	try {
		return JSON.parse(item?.output ?? "{}") as CodeOutput;
	} catch {
		return {};
	}
}

const calls = (items: Item[], tool: string) =>
	items.filter((item) => item.kind === "dynamicToolCall" && item.tool === tool);

const has = (text: string | undefined, ...needles: string[]) =>
	needles.every((needle) => (text ?? "").includes(needle));

// Repository instructions may come before the brief as their own user message.
const checkerBrief = (request: ModelRequestRecord | undefined) =>
	request?.users.find((user) => user.includes(CHECKER_MARKER));

const clip = (text: string | undefined, max = 300) =>
	(text ?? "").replaceAll(/\s+/g, " ").slice(0, max);

export async function checkScenario(
	id: ScenarioId,
	data: Collected & { vms: RehearsalVms; vm: string; task: TaskEnvironment },
): Promise<Check[]> {
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail?: string) =>
		checks.push({ name, ok, ...(detail && !ok ? { detail } : {}) });
	const root = data.rootTurns.at(-1);
	const items = root?.items ?? [];
	check(
		"root turn completed",
		root?.state === "completed",
		`state ${root?.state}`,
	);
	const errors = items.filter((item) => item.kind === "error");
	check(
		"no error items in the root turn",
		!errors.length,
		clip(JSON.stringify(errors), 600),
	);
	const requests = (agent: string) =>
		data.requests.filter((request) => request.agent === agent);
	const vmFile = async (vm: string, command: string) =>
		(await data.vms.root(vm, command)).stdout;
	/** rigor=on: the review rounds' captured requirements lists. */
	const reviewLists = () =>
		data.reviewState.flatMap(
			(row) =>
				(row.response as ReviewLoopState | null)?.rounds?.map(
					(round) => round.builderRequirements ?? null,
				) ?? [],
		);
	/** The checker brief carries the list after its own review parts, labelled as a claim. */
	const briefCarriesList = (
		brief: string | undefined,
		list: readonly string[],
	) =>
		has(
			brief,
			`<builder_requirements>\n${BUILDER_LIST_LABEL}\n${list.map((item) => `- ${item}`).join("\n")}\n</builder_requirements>`,
			"compare your list with the builder's understanding of the requirements",
		) &&
		(brief ?? "").indexOf("1. Requirements.") <
			(brief ?? "").indexOf("<builder_requirements>");
	/**
	 * Lines holding the list's mark in the task checkout's commits (every
	 * ref), its diff and its files, next to lines holding the run's own edit
	 * (which must be there, or the search saw nothing).
	 */
	const listLeak = async (edit: string) => {
		const search = (needle: string) =>
			`{ git -c safe.directory='*' log --all -p; git -c safe.directory='*' diff HEAD; grep -r --exclude-dir=.git -e '${needle}' .; } 2>/dev/null | grep -c -e '${needle}'`;
		const out = await vmFile(
			data.vm,
			`docker exec tb sh -c ${JSON.stringify(`cd /app && ${search(REQUIREMENTS_MARK)}; ${search(edit)}`)}`,
		);
		const [mark, own] = out.trim().split("\n").map(Number);
		return { mark, own, ok: mark === 0 && own > 0 };
	};
	const childItems = (role: string) =>
		data.children
			.filter((child) => child.agent_role === role)
			.flatMap((child) => child.items);

	if (id === "builder") {
		check(
			"builder made its scripted model calls",
			requests("builder").length >= 5,
		);
		const programs = calls(items, "run_code");
		const reads = parseOutput(programs[0]);
		check(
			"run_code: three parallel inner calls completed",
			reads.calls?.length === 3 &&
				reads.calls.every((call) => call.status === "completed"),
			clip(programs[0]?.output),
		);
		check(
			"run_code: bash ran in the task container at /app",
			has(reads.result, "in-container", "/app"),
			clip(reads.result),
		);
		const edit = parseOutput(programs[1]);
		check(
			"run_code: edit applied, then make test built and passed",
			has(
				edit.result,
				"1 edit applied",
				"mkdir -p build",
				"rehearsal edit applied",
				"all regression tests passed",
			),
			clip(edit.result, 500),
		);
		const shells = calls(items, "bash");
		check(
			"bash: the long command outlived its step and was left running",
			/^running \(/.test(shells[0]?.output ?? ""),
			clip(shells[0]?.output),
		);
		check(
			"bash: ytimesy-job wait returned its exit and output",
			has(shells[1]?.input, "ytimesy-job wait") &&
				has(shells[1]?.output, "exited", "REPRO_EXIT="),
			clip(shells[1]?.output),
		);
		check(
			"a provider 200 without a body was resent and the turn finished",
			data.faults.includes("builder:4") &&
				items.some(
					(item) =>
						item.kind === "agentMessage" &&
						has(item.text, "Rehearsal builder finished"),
				),
			JSON.stringify(data.faults),
		);
		// e. The collect path: the runner's stage script on the agent VM (as root).
		const staged = await data.vms.root(
			data.vm,
			`${stageScript(data.task)}\ntar -xzOf /tb/artifacts.tgz --wildcards '*regression_test.cc' | grep -c 'rehearsal edit applied'`,
		);
		check(
			"collect: the stage script packed the task's artifacts with the edit",
			staged.code === 0 &&
				has(staged.stdout, "STAGED") &&
				staged.stdout.trim().endsWith("1"),
			clip(staged.stdout + staged.stderr, 400),
		);
		check(
			"the edit is in the task container's checkout",
			(
				await vmFile(
					data.vm,
					"docker exec tb grep -c 'rehearsal edit applied' /app/tests/regression_test.cc",
				)
			).trim() === "1",
		);
	}

	if (id === "review") {
		const checker = data.children.filter(
			(child) => child.agent_role === "checker",
		);
		check(
			"a checker subagent ran",
			checker.length >= 1,
			`children ${data.children.map((child) => child.agent_role).join(",")}`,
		);
		const checkerCalls = requests("checker");
		check(
			"the checker ran on its own model (gpt-6-luna)",
			checkerCalls.length >= 3 &&
				checkerCalls.every((call) => call.model === "gpt-6-luna"),
			checkerCalls.map((call) => call.model).join(","),
		);
		const programs = calls(childItems("checker"), "run_code");
		const look = parseOutput(programs[0]);
		check(
			"checker: pwd/ls/git diff ran as the reader in the container",
			has(look.result, "/app", "999", "diff --git", "rehearsal edit applied"),
			clip(look.result),
		);
		const work = parseOutput(programs[1]);
		const [copy, write, make, probe] = work.calls ?? [];
		check(
			"checker: copied the checkout into its scratch as a directory",
			copy?.status === "completed" && /"output":"d/.test(copy.output),
			clip(copy?.output),
		);
		check(
			"checker: wrote a new test under <scratch>/tests",
			has(write?.output, "PROBE_WRITTEN"),
			clip(write?.output),
		);
		check(
			"checker: make test created build/ in the copy and passed",
			make?.status === "completed" &&
				has(make.output, "mkdir -p build", "all regression tests passed"),
			clip(make?.output, 500),
		);
		check(
			"checker: its own test ran and passed",
			has(probe?.output, "PROBE_PASSED"),
			clip(probe?.output),
		);
		const reviews = calls(items, "review_check");
		check(
			"review 1 failed with the failing test's command",
			has(
				reviews[0]?.output,
				"Review 1: fail",
				"Failing test:",
				"rehearsal_probe.sh",
			),
			clip(reviews[0]?.output, 500),
		);
		const notice = requests("review-builder").find((request) =>
			request.lastUser.includes("independent checker reviewed your work"),
		);
		check(
			"the builder's next model request carried the findings and the failing test",
			has(notice?.lastUser, "F1.", "rehearsal_probe.sh"),
			clip(notice?.lastUser, 500),
		);
		check(
			"review 2 passed after the builder's fix",
			reviews.some((review) => has(review.output, "Review 2: pass")),
			reviews.map((review) => clip(review.output, 160)).join(" / "),
		);
		// Without rigor and outputCap (the controls for scenario rigor).
		check(
			"without rigor=on the builder has no rigor block",
			requests("review-builder").every(
				(request) => !has(request.instructions, RIGOR_BLOCK),
			),
		);
		check(
			"without rigor=on the checker brief has no rigor checks",
			checkerCalls.length >= 1 &&
				checkerCalls.every((request) => {
					const brief = checkerBrief(request);
					return (
						!!brief && RIGOR_CHECKER_LINES.every((line) => !has(brief, line))
					);
				}),
			clip(checkerBrief(checkerCalls[0])),
		);
		check(
			"without rigor=on the builder is not asked for a requirements list",
			requests("review-builder").every(
				(request) => !has(request.instructions, REQUIREMENTS_INSTRUCTION),
			),
		);
		check(
			"without rigor=on a list the builder wrote is not captured or given to the checker",
			has(
				data.rootItems.find((item) => has(item.text, "<requirements>"))?.text,
				BUILDER_REQUIREMENTS[0],
			) &&
				reviewLists().length >= 1 &&
				reviewLists().every((list) => list === null) &&
				checkerCalls.every(
					(request) =>
						!has(checkerBrief(request), "builder_requirements") &&
						!has(checkerBrief(request), REQUIREMENTS_MARK),
				),
			JSON.stringify(reviewLists()),
		);
		// Scenarios run at once against one fake; rigor's capped output is in it too.
		const ownCalls = [...requests("review-builder"), ...checkerCalls];
		check(
			"without outputCap no tool output is capped",
			ownCalls.every((request) =>
				request.lastOutputs.every((output) => !has(output, CAP_NOTE)),
			),
		);
	}

	if (id === "review-pair") {
		const judges = data.children.filter(
			(child) => child.agent_role === "checker",
		);
		const judgeIds = new Set(judges.map((judge) => judge.id));
		const workers = data.children.filter((child) =>
			judgeIds.has(child.parent_session_id),
		);
		check(
			"one judge per round (2), each a checker on gpt-6.1-sol marked as the pair's judge",
			judges.length === 2 &&
				judges.every(
					(judge) =>
						judge.listed_model_id === "gpt-6.1-sol" &&
						judge.agent_budget?.checkerPair === "judge",
				),
			JSON.stringify(
				judges.map((judge) => [judge.listed_model_id, judge.agent_budget]),
			),
		);
		check(
			"each judge started its own worker: a read-only reader on gpt-6-luna on the shared VM, marked as the worker",
			workers.length === 2 &&
				judges.every((judge) =>
					workers.some((worker) => worker.parent_session_id === judge.id),
				) &&
				workers.every(
					(worker) =>
						worker.agent_role === "researcher" &&
						worker.listed_model_id === "gpt-6-luna" &&
						worker.task_access === "read_only" &&
						worker.task_placement === "shared" &&
						worker.agent_budget?.checkerPair === "worker",
				),
			JSON.stringify(
				workers.map((worker) => [
					worker.agent_role,
					worker.listed_model_id,
					worker.task_access,
					worker.task_placement,
					worker.agent_budget?.checkerPair,
				]),
			),
		);
		const judgeCalls = requests("pair-judge");
		const workerCalls = requests("pair-worker");
		check(
			"the judges ran on gpt-6.1-sol with checker_worker and no agent tool",
			judgeCalls.length >= 6 &&
				judgeCalls.every(
					(request) =>
						request.model === "gpt-6.1-sol" &&
						request.tools.includes("checker_worker") &&
						!request.tools.includes("agent"),
				),
			judgeCalls
				.map((request) => `${request.model}:${request.tools.join("/")}`)
				.join(" "),
		);
		check(
			"the workers ran on gpt-6-luna and can start no agent",
			workerCalls.length >= 4 &&
				workerCalls.every(
					(request) =>
						request.model === "gpt-6-luna" &&
						!request.tools.includes("agent") &&
						!request.tools.includes("checker_worker"),
				),
			workerCalls
				.map((request) => `${request.model}:${request.tools.join("/")}`)
				.join(" "),
		);
		const briefs = judgeCalls
			.filter((request) => request.step === 0)
			.map((request) => checkerBrief(request) ?? "");
		check(
			"both rounds are full checks: the judge's whole brief with the pair section; round 2 adds round 1's findings as context",
			briefs.length === 2 &&
				briefs.every((brief) =>
					has(
						brief,
						"[rehearsal:review-pair]",
						"Review in four parts:",
						"4. Test it yourself.",
						"<checker_pair>",
					),
				) &&
				!has(briefs[0], "<previous_review>") &&
				has(
					briefs[1],
					"<previous_review>",
					"this review is a full, independent check of all four parts",
					"Review 1, F1: Rehearsal finding",
				),
			clip(briefs[1]?.slice(briefs[1].indexOf("<previous_review>")), 400),
		);
		const workerBriefs = workerCalls
			.filter((request) => request.step === 0)
			.map((request) => request.users.join("\n"));
		check(
			"each worker saw only the judge's brief in the runtime's frame: no request, no builder conversation",
			workerBriefs.length === 2 &&
				workerBriefs.every(
					(brief) =>
						has(brief, PAIR_WORKER_MARKER, "<judge_brief>", PAIR_WORKER_TAG) &&
						!has(brief, "[rehearsal:review-pair]") &&
						!has(brief, "<request>") &&
						!has(brief, "Rehearsal change made") &&
						!has(brief, "<requirements>"),
				),
			clip(workerBriefs[0], 400),
		);
		const workerRuns = workers.map((worker) => {
			const [who, copy, write] =
				parseOutput(calls(worker.items, "run_code")[0]).calls ?? [];
			const shells = calls(worker.items, "bash").map(
				(call) => `${call.input}\n${call.output}`,
			);
			return { who, copy, write, shells: shells.join("\n") };
		});
		check(
			"each round's worker ran the whole check as the reader in the container: copy, new test, make test, the test",
			workerRuns.length === 2 &&
				workerRuns.every(
					(run) =>
						has(run.who?.output, "/app", "999", "READ_ONLY_OK") &&
						run.copy?.status === "completed" &&
						has(run.write?.output, "PROBE_WRITTEN") &&
						has(
							run.shells,
							"make test",
							"all regression tests passed",
							"rehearsal_probe.sh",
							"PROBE_PASSED",
						),
				),
			clip(JSON.stringify(workerRuns), 800),
		);
		check(
			"the worker's evidence reached each judge before its next model call (the tool's result, or its report held for it)",
			judgeCalls.filter((request) => request.step === 1).length === 2 &&
				judgeCalls
					.filter((request) => request.step === 1)
					.every((request) =>
						has(
							request.users.join("\n") + request.lastOutputs.join("\n"),
							"researcher finished",
							"PROBE_PASSED",
						),
					),
			clip(
				JSON.stringify(
					judgeCalls
						.filter((request) => request.step === 1)
						.map((request) => request.lastUser.slice(0, 200)),
				),
				500,
			),
		);
		const spot = judges.map((judge) =>
			parseOutput(calls(judge.items, "run_code")[0]),
		);
		check(
			"the judge spot-checked the shared scratch itself as the reader",
			spot.length === 2 &&
				spot.every((program) =>
					has(program.result, "999", "rehearsal_probe.sh"),
				),
			clip(JSON.stringify(spot.map((program) => program.result)), 300),
		);
		const state = data.reviewState
			.map((row) => row.response as ReviewLoopState | null)
			.find((entry) => entry?.rounds?.length);
		const rounds = state?.rounds ?? [];
		check(
			"the verdicts are the judge's JSON: review 1 fail with its failing test, review 2 pass; tests marked as run by the worker",
			rounds.length === 2 &&
				rounds[0]?.verdict?.verdict === "fail" &&
				rounds[1]?.verdict?.verdict === "pass" &&
				rounds.every(
					(round) =>
						round.checker.pair === true &&
						round.verdict?.notes.startsWith("rehearsal pair review") &&
						round.verdict.tests.length === 1 &&
						round.verdict.tests[0]?.ranBy === "worker",
				),
			clip(JSON.stringify(rounds.map((round) => round.verdict)), 600),
		);
		check(
			"each round recorded its worker's spend apart from the judge's",
			rounds.every(
				(round) =>
					(round.checker.usage?.inputTokens ?? 0) > 0 &&
					round.checker.workers?.length === 1 &&
					(round.checker.workers[0]?.usage?.inputTokens ?? 0) > 0 &&
					round.checker.workers[0]?.model?.modelId === "gpt-6-luna",
			),
			clip(JSON.stringify(rounds.map((round) => round.checker)), 600),
		);
		const reviews = calls(items, "review_check");
		check(
			"the chat's review summary splits the checker's spend as judge and worker",
			reviews.length >= 2 &&
				reviews.every((review) =>
					/Checker spent \d+k tokens.*\(judge \d+k.*, worker \d+k/.test(
						review.output ?? "",
					),
				) &&
				has(reviews[0]?.output, "Review 1: fail", "rehearsal_probe.sh") &&
				reviews.some((review) => has(review.output, "Review 2: pass")),
			reviews.map((review) => clip(review.output, 300)).join(" / "),
		);
		const notice = requests("pair-builder").find((request) =>
			request.lastUser.includes("independent checker reviewed your work"),
		);
		check(
			"the builder got the judge's findings and failing test",
			has(notice?.lastUser, "F1. Rehearsal finding", "rehearsal_probe.sh"),
			clip(notice?.lastUser, 400),
		);
	}

	if (id === "rigor") {
		const builder = requests("rigor-builder");
		check(
			"rigor=on: the builder's instructions carry the rigor block",
			builder.length >= 4 &&
				builder.every((request) => has(request.instructions, RIGOR_BLOCK)),
			`${builder.length} requests`,
		);
		const checker = requests("rigor-checker");
		check(
			"rigor=on: the checker brief carries the rigor checks",
			checker.length >= 1 &&
				checker.every((request) =>
					RIGOR_CHECKER_LINES.every((line) => has(checkerBrief(request), line)),
				) &&
				checker.every((request) => !has(request.instructions, RIGOR_BLOCK)),
			clip(checkerBrief(checker[0]), 300),
		);
		check(
			"rigor=on: the builder is asked for its requirements list (not as a lead)",
			builder.every(
				(request) =>
					has(request.instructions, REQUIREMENTS_INSTRUCTION) &&
					!has(request.instructions, LEAD_REQUIREMENTS_INSTRUCTION),
			),
		);
		check(
			"rigor=on: the builder's list was captured on every review round",
			reviewLists().length >= 2 &&
				reviewLists().every(
					(list) =>
						JSON.stringify(list) === JSON.stringify(BUILDER_REQUIREMENTS),
				),
			JSON.stringify(reviewLists()),
		);
		check(
			"rigor=on: the checker brief carries the list, labelled as the builder's claim, after its own parts",
			checker.length >= 1 &&
				checker.every((request) =>
					briefCarriesList(checkerBrief(request), BUILDER_REQUIREMENTS),
				),
			clip(
				checkerBrief(checker[0])?.slice(
					checkerBrief(checker[0])?.indexOf("<builder_requirements>"),
				),
				400,
			),
		);
		const leak = await listLeak("rehearsal edit applied");
		check(
			"rigor=on: the list is in no commit, diff or file of the checkout",
			leak.ok,
			JSON.stringify(leak),
		);
		const seq = builder.find((request) => request.step === 1)?.lastOutputs[0];
		check(
			"outputCap=10000: the long command output reached the model capped, head and tail kept, with where the rest is",
			!!seq &&
				seq.length < 11_000 &&
				has(seq, CAP_NOTE, "the full output is in ", "\n29999\n30000"),
			`${seq?.length} chars: ${clip(seq?.slice(0, 200))}`,
		);
		const notice = builder.find((request) =>
			request.lastUser.includes("independent checker reviewed your work"),
		);
		check(
			"rigor=on: the admitted gap came back as F1 although the checker passed",
			has(
				notice?.lastUser,
				"F1. Your final answer admits unverified or open work",
				ADMITTED_LINE,
			),
			clip(notice?.lastUser, 400),
		);
		const reviews = calls(items, "review_check");
		check(
			"review 1 passed but was sent back; review 2 passed and finished",
			reviews.some((review) => has(review.output, "Review 1: pass")) &&
				reviews.some((review) => has(review.output, "Review 2: pass")) &&
				!reviews.some((review) => has(review.output, "Review ended")),
			reviews.map((review) => clip(review.output, 160)).join(" / "),
		);
		check(
			"the builder ran at effort high",
			builder.every((request) => request.effort === "high"),
			builder.map((request) => request.effort).join(","),
		);
		check(
			"the checker on another model (gpt-6-luna) inherited effort high",
			checker.length >= 1 &&
				checker.every(
					(request) =>
						request.model === "gpt-6-luna" && request.effort === "high",
				),
			checker.map((request) => `${request.model}@${request.effort}`).join(","),
		);
	}

	if (id === "subagents") {
		const writer = data.children.find((child) => child.agent_role === "writer");
		const writerCalls = requests("writer");
		check(
			"the writer made model calls (1 round)",
			writerCalls.length >= 2,
			`${writerCalls.length} calls`,
		);
		const started = calls(items, "agent");
		check(
			"the agent tool started the writer on a fork",
			has(started[0]?.output, '"vm": "fork"'),
			clip(started[0]?.output),
		);
		check(
			"the writer worked in its fork's task container",
			calls(writer?.items ?? [], "run_code").some((item) =>
				has(
					parseOutput(item).result,
					"/app",
					"1 edit applied",
					"ytimesy fork base",
				),
			),
			clip(calls(writer?.items ?? [], "run_code")[0]?.output),
		);
		const applied = calls(items, "run_code").filter((item) =>
			has(item.input, "git apply"),
		);
		check(
			"the lead applied 1 patch from absolute paths",
			applied.length === 1 &&
				applied.every(
					(item) =>
						has(parseOutput(item).result, "PATCH_APPLIED") &&
						has(item.input, "/home/ubuntu/.ytimesy/agents/"),
				),
			applied.map((item) => clip(parseOutput(item).result, 200)).join(" / "),
		);
		check(
			"the fork's patch record is absolute",
			String(
				(writer?.agent_fork?.patch as { path?: string } | undefined)?.path ??
					"",
			).startsWith("/home/ubuntu/.ytimesy/agents/"),
			JSON.stringify(writer?.agent_fork?.patch),
		);
		check(
			"the lead's checkout has the writer's work",
			has(
				await vmFile(
					data.vm,
					"docker exec tb head -1 /app/include/mvcc_lsm/types.h",
				),
				"rehearsal round 1",
			),
		);
		const researcher = data.children.find(
			(child) => child.agent_role === "researcher",
		);
		const look = parseOutput(calls(researcher?.items ?? [], "run_code")[0]);
		check(
			"the researcher ran read-only in the task container",
			has(look.result, "/app", "in-container", "READ_ONLY_OK") &&
				!has(look.result, "\\n0\\n"),
			clip(look.result),
		);
		check(
			"the awaited researcher's report came back in the agent tool result",
			started.some((item) => has(item.output, "Rehearsal researcher report")),
			started.map((item) => clip(item.output, 200)).join(" / "),
		);
	}

	if (
		id === "fusion" ||
		id === "fusion-explore" ||
		id === "fusion-multiturn" ||
		id === "fusion-stuck" ||
		id === "fusion-handback" ||
		id === "fusion-classifier-fail"
	) {
		const leadName = {
			fusion: "fusion-lead",
			"fusion-explore": "explore-lead",
			"fusion-multiturn": "multiturn-lead",
			"fusion-stuck": "stuck-lead",
			"fusion-handback": "handback-lead",
			"fusion-classifier-fail": "clsfail-lead",
		}[id];
		const sidekickName = {
			fusion: "sidekick",
			"fusion-explore": "explore-sidekick",
			"fusion-multiturn": "mt-sidekick",
			"fusion-stuck": "stuck-sidekick",
			"fusion-handback": "handback-sidekick",
			"fusion-classifier-fail": "clsfail-sidekick",
		}[id];
		const writers = data.children.filter(
			(child) => child.agent_role === "writer",
		);
		const sidekick = writers[0];
		const state = sidekick?.agent_budget?.sidekick;
		const metrics = fusionTurnMetrics({
			rootId: data.sessionId,
			sessions: [
				{
					id: data.sessionId,
					parentSessionId: null,
					harness: data.rootHarness,
					listedModelId: data.rootModel,
					items: data.rootItems,
				},
				...data.children.map((child) => ({
					id: child.id,
					parentSessionId: child.parent_session_id,
					harness: child.harness,
					listedModelId: child.listed_model_id,
					items: child.items,
					agentRole: child.agent_role as never,
					agentBudget: child.agent_budget,
				})),
			],
		});
		// The chat's whole history (a turn's items repeat earlier turns').
		const sends = calls(data.rootItems, "agent_send");
		const head = async (path: string) =>
			vmFile(data.vm, `docker exec tb head -1 /app/${path}`);
		const lead = requests(leadName);
		const sidekickCalls = requests(sidekickName);
		const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
		const rounds = writers.flatMap(
			(writer) => writer.agent_budget?.sidekick?.rounds ?? [],
		);

		// 1. The user's task, then the sidekick's code exploration, started by the harness.
		check(
			"the harness started the exploration round before the lead's first model call",
			state?.rounds[0]?.kind === "explore" &&
				has(
					sidekickCalls[0]?.users.join("\n"),
					HARNESS_EXPLORE_HEADING,
					`[rehearsal:${id}]`,
				) &&
				time(state?.rounds[0]?.startedAt) < (lead[0]?.at ?? 0) &&
				(sidekickCalls[0]?.at ?? Infinity) < (lead[0]?.at ?? 0) &&
				!calls(data.rootItems, "agent").length,
			JSON.stringify({
				round: state?.rounds[0],
				sidekickFirst: sidekickCalls[0]?.at,
				leadFirst: lead[0]?.at,
				agentCalls: calls(data.rootItems, "agent").length,
			}),
		);
		// 2. File snippets: the lead's first request carries them.
		check(
			"the lead's first model request carried the exploration report (files, snippets, commands)",
			has(
				lead[0]?.users.find((text) => has(text, "Snippets:")),
				"Files:",
				`${EXPLORE_FILE}:1-3`,
				"#ifndef MVCC_LSM_TYPES_H_",
				"Commands:",
				"Open questions:",
			),
			clip(lead[0]?.lastUser, 500),
		);
		// 3. One shared workspace: the sidekick is a writer in the lead's checkout.
		const leadForks = data.forks.filter((fork) => fork.source === data.vm);
		check(
			"the sidekick works in the lead's checkout as a writer (shared VM, no fork, no patch)",
			writers.length > 0 &&
				writers.every(
					(writer) =>
						writer.provider_ref === data.vm &&
						writer.task_placement === "shared" &&
						writer.task_access === "read_write" &&
						!writer.agent_fork,
				) &&
				!leadForks.length &&
				!has(JSON.stringify(data.rootItems), ".ytimesy/agents/") &&
				!calls(data.rootItems, "run_code").some((item) =>
					has(item.input, "git apply"),
				),
			JSON.stringify({
				writers: writers.map((writer) => ({
					vm: writer.provider_ref,
					placement: writer.task_placement,
					access: writer.task_access,
					fork: writer.agent_fork,
				})),
				leadVm: data.vm,
				forks: leadForks,
			}),
		);
		const where = calls(sidekick?.items ?? [], "run_code")
			.map((item) => parseOutput(item).result ?? "")
			.find((result) => has(result, "WHERE<<"));
		check(
			"the sidekick ran as the builder's user in the task container (not the reader)",
			has(where, "/app", "in-container") && !/\b999\b/.test(where ?? ""),
			clip(where, 300),
		);
		// 4. One writer at a time: the lead makes no model call while a round runs.
		const during = lead.filter((request) =>
			rounds.some(
				(round) =>
					time(round.startedAt) < request.at &&
					request.at < (round.endedAt ? time(round.endedAt) : Infinity),
			),
		);
		check(
			"the lead made no model call (and no edit) while a sidekick round ran",
			!during.length &&
				!calls(data.rootItems, "bash").some((item) =>
					has(item.input, "LEAD_DID_NOT_WAIT"),
				),
			JSON.stringify(
				during.map((request) => ({ at: request.at, step: request.step })),
			),
		);
		check(
			"the lead reviewed each build round in place (git diff of the round, git status)",
			calls(data.rootItems, "run_code")
				.filter((item) => has(item.input, "REVIEWED"))
				.every(
					(item) =>
						has(parseOutput(item).result, "REVIEWED", "+// rehearsal") &&
						!has(item.input, "NO-ROUND-DIFF"),
				) &&
				calls(data.rootItems, "run_code").filter((item) =>
					has(item.input, "REVIEWED"),
				).length === rounds.filter((round) => round.kind !== "explore").length,
			calls(data.rootItems, "run_code")
				.filter((item) => has(item.input, "REVIEWED"))
				.map((item) => clip(parseOutput(item).result, 200))
				.join(" / "),
		);
		// 5. The lead waits: its final answer comes after the last round's report.
		const lastEnd = Math.max(...rounds.map((round) => time(round.endedAt)));
		const finalAnswer = lead.at(-1);
		check(
			"the lead's final answer came after the last round's report",
			Number.isFinite(lastEnd) &&
				(finalAnswer?.at ?? 0) > lastEnd &&
				"text" in (finalAnswer?.reply ?? {}) &&
				rounds.every((round) => round.endedAt) &&
				data.rootTurns.every((turn) => turn.state === "completed"),
			JSON.stringify({ lastEnd, final: finalAnswer?.at }),
		);
		check(
			"the sidekick ran on roleModels.writer (gpt-6-luna)",
			sidekickCalls.length >= 2 &&
				sidekickCalls.every((call) => call.model === "gpt-6-luna"),
			sidekickCalls.map((call) => call.model).join(","),
		);

		if (id === "fusion") {
			check(
				"build rounds' changes are in the lead's checkout (rounds 2 and 3)",
				has(await head(EXPLORE_FILE), "rehearsal round 2") &&
					has(await head("src/lsm_db.cc"), "rehearsal round 3"),
			);
			check(
				"round 2's message told the sidekick it works in the lead's checkout",
				sidekickCalls.some((request) =>
					request.lastUser.includes(
						"Round 2/6 from your lead. You work in the lead's checkout as it is now",
					),
				),
			);
			const probe = calls(data.rootItems, "run_code").find((item) =>
				has(item.input, "lead write during a round"),
			);
			check(
				"a lead edit sent with the handoff was refused (one writer at a time)",
				has(
					parseOutput(probe).result,
					"Your sidekick is working in your checkout",
				) &&
					!has(await head("src/version_set.cc"), "lead write during a round"),
				clip(probe?.output, 400),
			);
			check(
				"metrics: one exploration and two build rounds, no lead edit took effect, no patch applied",
				metrics.explorationHandoffs === 1 &&
					metrics.sidekickRounds === 3 &&
					metrics.patchesApplied === 0 &&
					metrics.sidekicks === 1,
				JSON.stringify(metrics),
			);
			// The sidekick lives as long as the chat: idle after the lead's turn.
			check(
				"the idle sidekick stays for the chat after the lead's turn",
				!state?.retired,
				JSON.stringify({ retired: state?.retired }),
			);
		}

		if (id === "fusion")
			check(
				"without rigor=on the lead is not asked for a requirements list",
				lead.every(
					(request) =>
						!has(request.instructions, REQUIREMENTS_INSTRUCTION) &&
						!has(request.instructions, LEAD_REQUIREMENTS_INSTRUCTION),
				),
			);

		if (id === "fusion-explore") {
			check(
				"rigor=on: the lead is asked for the list as the lead; the sidekick gets the rigor block, not the list",
				lead.length >= 1 &&
					lead.every((request) =>
						has(
							request.instructions,
							REQUIREMENTS_INSTRUCTION,
							LEAD_REQUIREMENTS_INSTRUCTION,
						),
					) &&
					sidekickCalls.every(
						(request) =>
							has(request.instructions, RIGOR_BLOCK) &&
							!has(request.instructions, REQUIREMENTS_INSTRUCTION),
					),
			);
			check(
				"rigor=on: the lead's brief gave the sidekick its list's items",
				sidekickCalls.some((request) =>
					request.users.some((text) => has(text, LEAD_REQUIREMENTS[0])),
				),
			);
			const checker = requests("explore-checker");
			check(
				"rigor=on: the lead's list was captured and the checker got it as a claim",
				reviewLists().length >= 1 &&
					reviewLists().every(
						(list) =>
							JSON.stringify(list) === JSON.stringify(LEAD_REQUIREMENTS),
					) &&
					checker.length >= 1 &&
					checker.every((request) =>
						briefCarriesList(checkerBrief(request), LEAD_REQUIREMENTS),
					),
				JSON.stringify({
					lists: reviewLists(),
					brief: clip(checkerBrief(checker[0]), 200),
				}),
			);
			const leak = await listLeak("rehearsal explore build");
			check(
				"rigor=on: the lead's list is in no commit, diff or file of the checkout",
				leak.ok,
				JSON.stringify(leak),
			);
			check(
				"the exploration round changed no files and fired no signal",
				state?.rounds[0]?.patchFiles === 0 && !state?.rounds[0]?.signals,
				JSON.stringify(state?.rounds[0]),
			);
			check(
				"the lead read no files itself; the sidekick did the reading",
				metrics.leadReads === 0 && (metrics.sidekickReads ?? 0) >= 2,
				JSON.stringify({
					lead: metrics.leadReads,
					sidekick: metrics.sidekickReads,
				}),
			);
			check(
				"the lead's plan quoted the snippet in round 2's brief",
				has(String((sends[0] as Item | undefined)?.input), "harbor-canary"),
				clip((sends[0] as Item | undefined)?.input),
			);
			check(
				"metrics: one exploration handoff, two rounds",
				metrics.explorationHandoffs === 1 && metrics.sidekickRounds === 2,
				JSON.stringify(metrics),
			);
			check(
				"the build round's change reached the lead's checkout",
				has(await head(EXPLORE_FILE), "rehearsal explore build"),
			);
		}

		if (id === "fusion-multiturn") {
			check(
				"two user requests, both turns completed",
				data.rootTurns.length === 2 &&
					data.rootTurns.every((turn) => turn.state === "completed") &&
					has(JSON.stringify(data.rootItems), MULTITURN_FOLLOW_UP.slice(0, 40)),
				data.rootTurns.map((turn) => turn.state).join(","),
			);
			check(
				"one sidekick served both requests (no second writer)",
				writers.length === 1 && state?.turns === 2,
				JSON.stringify({ writers: writers.length, turns: state?.turns }),
			);
			check(
				"the second request was explored first, by the same sidekick, before the lead's first call of that turn",
				state?.rounds[2]?.kind === "explore" &&
					sidekickCalls.some((request) =>
						has(
							request.lastUser,
							"Round 3 from your lead (1/6 for the user's new request)",
							HARNESS_EXPLORE_HEADING,
							"[rehearsal:fusion-multiturn-2]",
						),
					) &&
					time(state?.rounds[2]?.startedAt) <
						(lead.find((request) =>
							request.users.some((text) =>
								has(text, "[rehearsal:fusion-multiturn-2]"),
							),
						)?.at ?? 0),
				JSON.stringify(state?.rounds[2]),
			);
			check(
				"the second turn's first lead request carried the new exploration report",
				Boolean(
					lead
						.find((request) =>
							request.users.some((text) =>
								has(text, "[rehearsal:fusion-multiturn-2]"),
							),
						)
						?.users.some((text) =>
							has(text, "round 3 (1/6 this turn)", "Snippets:"),
						),
				),
			);
			const keys = new Set(sidekickCalls.map((request) => request.cacheKey));
			check(
				"the sidekick kept one session across turns (same prompt cache key)",
				sidekickCalls.length >= 8 && keys.size === 1 && !keys.has(null),
				JSON.stringify([...keys]),
			);
			check(
				"round 4's change reached the lead's checkout",
				has(await head("src/lsm_db.cc"), "rehearsal round 4") &&
					has(await head(EXPLORE_FILE), "rehearsal round 2"),
			);
			check(
				"stopping the sidekick retired it",
				state?.retired?.reason === "stopped by the lead",
				JSON.stringify({ retired: state?.retired }),
			);
		}

		const decisions = state?.decisions ?? [];
		check(
			"every sidekick round has a recorded classifier decision (hash, latency, source)",
			decisions.filter((entry) => entry.point === "round").length ===
				(state?.rounds.filter((round) => round.endedAt).length ?? -1) &&
				decisions.every(
					(entry) =>
						/^[0-9a-f]{64}$/.test(entry.inputsHash) &&
						entry.latencyMs >= 0 &&
						(entry.source === "classifier" || entry.source === "rules"),
				),
			JSON.stringify(decisions),
		);

		if (id === "fusion-stuck") {
			const notice =
				"looks stuck (rehearsal: it failed make bogus-check twice the same way)";
			check(
				"rounds 1 and 2 carried no notice (the classifier said on_track)",
				lead.some((request) => /round 2\/6/.test(request.lastUser)) &&
					!lead.some(
						(request) =>
							/round [12]\/6/.test(request.lastUser) &&
							has(request.lastUser, "Runtime notice"),
					) &&
					decisions
						.slice(0, 2)
						.every(
							(entry) =>
								entry.decision === "on_track" && entry.source === "classifier",
						),
				JSON.stringify(decisions.slice(0, 2)),
			);
			const stuck = lead.find((request) => has(request.lastUser, notice));
			check(
				"the lead's next request after round 3 carried the classifier's switch notice",
				has(
					stuck?.lastUser,
					"round 3/6",
					"The runtime switches it to codex:gpt-6.1-sol at its next context compaction",
				),
				clip(
					lead
						.map((request) => request.lastUser)
						.find((text) => /round 3\/6/.test(text)),
					600,
				),
			);
			check(
				"round 3: the same-check-failed signal fed the classifier, which said switch_model",
				state?.rounds[2]?.signals?.[0]?.kind === "same-check-failed" &&
					decisions[2]?.decision === "switch_model" &&
					decisions[2]?.source === "classifier" &&
					requests("classifier").some((request) =>
						has(request.lastUser, "same-check-failed: make bogus-check"),
					),
				JSON.stringify({ round: state?.rounds[2], decision: decisions[2] }),
			);
			const summaries = requests("summarizer");
			check(
				"round 4 started with a compaction on the old model (a neutral summary)",
				summaries.length === 1 && summaries[0]?.model === "gpt-6-luna",
				JSON.stringify(summaries.map((request) => request.model)),
			);
			const escalated = requests("escalated-sidekick");
			const old = requests("stuck-sidekick");
			check(
				"the same sidekick session continued on writerEscalation after the compaction",
				writers.length === 1 &&
					sidekick?.listed_model_id === "gpt-6.1-sol" &&
					escalated.length >= 2 &&
					escalated.every((request) => request.model === "gpt-6.1-sol") &&
					old.every((request) => request.model === "gpt-6-luna") &&
					// One session: the same prompt cache scope on both models.
					new Set([...old, ...escalated].map((request) => request.cacheKey))
						.size === 1,
				JSON.stringify({
					writers: writers.length,
					model: sidekick?.listed_model_id,
					keys: [
						...new Set(
							[...old, ...escalated].map((request) => request.cacheKey),
						),
					],
				}),
			);
			check(
				"the escalated model started from the compacted summary with a runtime note",
				has(
					escalated[0]?.lastUser,
					"you now run on gpt-6.1-sol",
					"Continue the current round from the summary above",
				) && !has(escalated[0]?.lastUser, "rehearsal stuck 1"),
				clip(escalated[0]?.lastUser, 500),
			);
			check(
				"the switch was recorded (pending, compacted, round 4) and nothing is pending",
				state?.switches?.length === 1 &&
					state.switches[0]?.from === "gpt-6-luna" &&
					state.switches[0]?.to === "gpt-6.1-sol" &&
					state.switches[0]?.trigger === "pending" &&
					state.switches[0]?.compacted === true &&
					state.switches[0]?.round === 4 &&
					!state.pendingSwitch &&
					!state.retired,
				JSON.stringify({
					switches: state?.switches,
					pending: state?.pendingSwitch,
				}),
			);
			check(
				"metrics: signals, decisions and one model switch",
				(metrics.signals?.["same-check-failed"] ?? 0) >= 1 &&
					metrics.switches === 1 &&
					metrics.decisions?.switch_model === 1 &&
					(metrics.decisions?.on_track ?? 0) >= 2 &&
					metrics.classifierFallbacks === 0,
				JSON.stringify({
					signals: metrics.signals,
					switches: metrics.switches,
					decisions: metrics.decisions,
				}),
			);
			check(
				"every round's change reached the lead's checkout",
				has(await head(EXPLORE_FILE), "rehearsal stuck 1") &&
					has(await head("src/lsm_db.cc"), "rehearsal stuck 2") &&
					has(await head("src/snapshot_context.cc"), "rehearsal escalated"),
			);
		}

		if (id === "fusion-handback") {
			const lead = requests("handback-lead");
			const notice = lead.find((request) =>
				has(request.lastUser, "Runtime notice: sidekick 1 needs you"),
			);
			check(
				"the classifier's hand_back notice reached the lead with its reason",
				has(
					notice?.lastUser,
					"needs you (rehearsal: the brief leaves src/lsm_db.cc to the lead)",
					"or take over and do it yourself",
				),
				clip(
					lead
						.map((request) => request.lastUser)
						.find((text) => /round 2\/6/.test(text)),
					600,
				),
			);
			check(
				"the build round's decision was recorded as the classifier's hand_back; no switch",
				decisions[0]?.decision === "on_track" &&
					decisions[1]?.decision === "hand_back" &&
					decisions[1]?.source === "classifier" &&
					decisions[1]?.model === "gpt-6-luna" &&
					!state?.pendingSwitch &&
					!state?.switches?.length,
				JSON.stringify(decisions),
			);
			check(
				"the lead took over and edited itself (lead edit rate counted)",
				metrics.leadEdits >= 1 &&
					(metrics.leadEditRate ?? 0) > 0 &&
					metrics.decisions?.hand_back === 1 &&
					has(await head("src/lsm_db.cc"), "rehearsal lead took over"),
				JSON.stringify({
					leadEdits: metrics.leadEdits,
					rate: metrics.leadEditRate,
					decisions: metrics.decisions,
				}),
			);
		}

		if (id === "fusion-classifier-fail") {
			const lead = requests("clsfail-lead");
			check(
				"an unparsable classifier answer fell back to the rules, for every build round",
				decisions.length === 3 &&
					decisions[0]?.source === "classifier" &&
					decisions
						.slice(1)
						.every(
							(entry) =>
								entry.source === "rules" &&
								has(entry.fallback, "unparsable reply: Looks stuck to me"),
						) &&
					requests("classifier").length >= 2,
				JSON.stringify(decisions),
			);
			check(
				"the rules: round 2 on_track; round 3 (same check failed, no escalation model) hand_back",
				decisions[1]?.decision === "on_track" &&
					decisions[2]?.decision === "hand_back" &&
					!state?.pendingSwitch,
				JSON.stringify(decisions),
			);
			check(
				"the rules' hand_back notice reached the lead",
				lead.some((request) =>
					has(
						request.lastUser,
						"Runtime notice: sidekick 1 needs you (it failed the same check as last round (`make bogus-check`))",
					),
				),
				clip(
					lead
						.map((request) => request.lastUser)
						.find((text) => /round 3\/6/.test(text)),
					600,
				),
			);
			check(
				"metrics: two rules fallbacks, one rework round",
				metrics.classifierFallbacks === 2 && metrics.reworkRounds === 1,
				JSON.stringify(metrics),
			);
		}
	}
	// Memory scenarios: subagents and the checker read the project's memory
	// (its always-on rules on their first request); only the root chat saves.
	if (id === "review" || id === "subagents") {
		for (const role of id === "review"
			? ["checker"]
			: ["writer", "researcher"]) {
			const roleRequests = requests(role);
			const first = roleRequests[0]?.users.join("\n\n");
			check(
				`memory: the ${role}'s first request carries the project's rules`,
				has(
					first,
					MEMORY_RULE,
					...(role === "checker"
						? ["<standing_rules>", "follows the project's remembered rules"]
						: [MEMORY_PROJECT_RULES_HEADER]),
				),
				clip(first?.slice(-800), 800),
			);
			check(
				`memory: the ${role} is never told to write memory`,
				roleRequests.length > 0 &&
					roleRequests.every(
						(request) => !request.instructions.includes(MEMORY_DIRECTORY),
					),
			);
		}
		const saves = data.memoryJobs.filter((job) => job.action === "save");
		const children = new Set(data.children.map((child) => child.id));
		check(
			"memory: the root chat's save hook was queued",
			saves.some((job) => job.sessionId === data.sessionId),
			JSON.stringify(data.memoryJobs),
		);
		check(
			"memory: no save hook ran for a subagent",
			saves.every(
				(job) =>
					job.sessionId === data.sessionId &&
					!(job.sessionId && children.has(job.sessionId)),
			),
			JSON.stringify(saves),
		);
	}

	return checks;
}
