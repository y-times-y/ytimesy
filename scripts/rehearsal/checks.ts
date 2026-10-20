// What a rehearsal scenario left behind (turn items, child sessions, model
// requests, VM state) and the checks each scenario must pass.
import {
	fusionTurnMetrics,
	type SidekickState,
} from "../../src/domain/sidekick";
import type { SubagentBudget } from "../../src/domain/subagent";
import { database } from "../../src/server/adapters/database";
import { stageScript, type TaskEnvironment } from "../hard-set/environment";
import type { RehearsalEdge } from "./edge";
import type { FakeCodex } from "./fake-codex";
import {
	type Check,
	EXPLORE_FILE,
	MULTITURN_FOLLOW_UP,
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
			provider_ref: string | null;
			agent_fork: Record<string, unknown> | null;
			agent_budget: (SubagentBudget & { sidekick?: SidekickState }) | null;
			listed_model_id: string | null;
			harness: string;
			items: Item[];
		}>(
			`with recursive tree as (select id from agent_session where id=$1
			 union all select s.id from agent_session s join tree t on s.parent_session_id=t.id)
			 select id,parent_session_id,agent_role,title,task_state,provider_ref,agent_fork,agent_budget,listed_model_id,harness,items
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
	}

	if (id === "fusion" || id === "subagents") {
		const writer = data.children.find((child) => child.agent_role === "writer");
		const writerName = id === "fusion" ? "sidekick" : "writer";
		const writerCalls = requests(writerName);
		const rounds = id === "fusion" ? 2 : 1;
		check(
			`the ${writerName} made model calls (${rounds} round${rounds > 1 ? "s" : ""})`,
			writerCalls.length >= 2 * rounds,
			`${writerCalls.length} calls`,
		);
		if (id === "fusion")
			check(
				"the sidekick ran on roleModels.writer (gpt-6-luna)",
				writerCalls.every((call) => call.model === "gpt-6-luna"),
				writerCalls.map((call) => call.model).join(","),
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
			`the lead applied ${rounds} patch${rounds > 1 ? "es" : ""} from absolute paths`,
			applied.length === rounds &&
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
		if (id === "fusion") {
			const sent = calls(items, "agent_send");
			check(
				"agent_send started round 2 after syncing the fork",
				has(
					sent[0]?.output,
					"round 2/6 started",
					"all its earlier work was in it",
				),
				clip(sent[0]?.output),
			);
			check(
				"round 2's change reached the lead",
				has(
					await vmFile(data.vm, "docker exec tb head -1 /app/src/lsm_db.cc"),
					"rehearsal round 2",
				),
			);
			// The sidekick lives as long as the chat: idle after the lead's turn,
			// its fork kept for the next message (until its idle TTL).
			check(
				"the idle sidekick stays for the chat after the lead's turn (fork kept)",
				!writer?.agent_budget?.sidekick?.retired &&
					!writer?.agent_fork?.deletedAt &&
					!data.destroyed.includes(String(writer?.agent_fork?.vmId)),
				JSON.stringify({
					retired: writer?.agent_budget?.sidekick?.retired,
					deletedAt: writer?.agent_fork?.deletedAt,
				}),
			);
		} else {
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
	}
	if (
		id === "fusion-explore" ||
		id === "fusion-multiturn" ||
		id === "fusion-stuck"
	) {
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
		const applied = calls(data.rootItems, "run_code").filter((item) =>
			has(item.input, "git apply"),
		);
		const head = async (path: string) =>
			vmFile(data.vm, `docker exec tb head -1 /app/${path}`);

		if (id === "fusion-explore") {
			const sidekickCalls = requests("explore-sidekick");
			check(
				"the first handoff was an exploration brief (explore: true, the report format appended)",
				state?.rounds[0]?.kind === "explore" &&
					has(sidekickCalls[0]?.lastUser, "Exploration round: change no files"),
				JSON.stringify(state?.rounds[0]),
			);
			check(
				"the exploration round changed no files and fired no signal",
				state?.rounds[0]?.patchFiles === 0 && !state?.rounds[0]?.signals,
				JSON.stringify(state?.rounds[0]),
			);
			const planned = requests("explore-lead").find((request) =>
				has(request.lastUser, "Snippets:"),
			);
			check(
				"the lead's next request carried the sidekick's files and snippets",
				has(
					planned?.lastUser,
					"Files:",
					`${EXPLORE_FILE}:1-12`,
					"#ifndef MVCC_LSM_TYPES_H_",
					"Commands:",
					"Open questions:",
				),
				clip(planned?.lastUser, 500),
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
				"the build round's patch reached the lead's checkout",
				applied.length === 1 &&
					has(await head(EXPLORE_FILE), "rehearsal explore build"),
				applied.map((item) => clip(parseOutput(item).result, 200)).join(" / "),
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
				"the second request's round started on the same sidekick after syncing its fork",
				has(
					sends[0]?.output,
					"round 2 (1/6 this turn) started",
					"all its earlier work was in it",
				) && state?.rounds[1]?.sync === "clean",
				clip(sends[0]?.output),
			);
			const keys = new Set(
				requests("mt-sidekick").map((request) => request.cacheKey),
			);
			check(
				"the sidekick kept one session across turns (same prompt cache key)",
				requests("mt-sidekick").length >= 4 &&
					keys.size === 1 &&
					!keys.has(null),
				JSON.stringify([...keys]),
			);
			check(
				"the second round's message was labelled for the new request",
				requests("mt-sidekick").some((request) =>
					has(
						request.lastUser,
						"Round 2 from your lead (1/6 for the user's new request)",
					),
				),
			);
			check(
				"round 2's change reached the lead",
				applied.length === 2 &&
					has(await head("src/lsm_db.cc"), "rehearsal round 2"),
			);
			check(
				"stopping the sidekick retired it and deleted its fork",
				state?.retired?.reason === "stopped by the lead" &&
					Boolean(sidekick?.agent_fork?.deletedAt) &&
					data.destroyed.includes(String(sidekick?.agent_fork?.vmId)),
				JSON.stringify({
					retired: state?.retired,
					deletedAt: sidekick?.agent_fork?.deletedAt,
				}),
			);
		}

		if (id === "fusion-stuck") {
			const lead = requests("stuck-lead");
			const notice =
				"looks stuck because it failed the same check as last round (`make bogus-check`)";
			const first = lead.find((request) =>
				has(request.lastUser, "rehearsal stuck 1"),
			);
			check(
				"round 1's report carried no stuck notice",
				Boolean(lead.find((request) => /round 1\/6/.test(request.lastUser))) &&
					!lead.some(
						(request) =>
							/round 1\/6/.test(request.lastUser) &&
							has(request.lastUser, "looks stuck"),
					),
				clip(first?.lastUser),
			);
			const stuck = lead.find((request) => has(request.lastUser, notice));
			check(
				"the lead's next request after round 2 carried the stuck notice",
				Boolean(stuck) &&
					has(
						stuck?.lastUser,
						"Re-brief it more prescriptively",
						"restarts it on codex:gpt-6.1-sol",
					),
				clip(
					lead
						.map((request) => request.lastUser)
						.find((text) => /round 2\/6/.test(text)),
					600,
				),
			);
			check(
				"round 2 recorded the same-check-failed signal",
				state?.rounds[1]?.signals?.[0]?.kind === "same-check-failed",
				JSON.stringify(state?.rounds[1]),
			);
			const escalated = writers[1];
			check(
				"the next round restarted the sidekick on roleModels.writerEscalation",
				has(sends[1]?.output, "was stuck", "restarted as sidekick 2") &&
					escalated?.listed_model_id === "gpt-6.1-sol" &&
					escalated?.agent_budget?.sidekick?.escalatedFrom?.label === "1" &&
					requests("escalated-sidekick").every(
						(request) => request.model === "gpt-6.1-sol",
					),
				clip(sends[1]?.output),
			);
			check(
				"the escalated sidekick got a handover of the stuck one's last report",
				has(
					requests("escalated-sidekick")[0]?.lastUser,
					"Its last report:",
					"make bogus-check still fails",
					"[rehearsal:escalated]",
				),
				clip(requests("escalated-sidekick")[0]?.lastUser, 500),
			);
			check(
				"the stuck sidekick was retired and its fork deleted",
				has(state?.retired?.reason, "restarted on gpt-6.1-sol") &&
					data.destroyed.includes(String(sidekick?.agent_fork?.vmId)),
				JSON.stringify(state?.retired),
			);
			check(
				"metrics: signals and one model switch",
				(metrics.signals?.["same-check-failed"] ?? 0) >= 1 &&
					metrics.switches === 1,
				JSON.stringify({
					signals: metrics.signals,
					switches: metrics.switches,
				}),
			);
			check(
				"the escalated sidekick's patch reached the lead",
				applied.length === 3 &&
					has(await head("src/snapshot_context.cc"), "rehearsal escalated"),
				applied.map((item) => clip(parseOutput(item).result, 160)).join(" / "),
			);
		}
	}
	return checks;
}
