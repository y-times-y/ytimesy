import { access, mkdir, writeFile } from "node:fs/promises";
import type { LanguageModel, ModelMessage } from "ai";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import {
	type ApiTokenUsage,
	addApiTokenUsage,
} from "../../src/domain/api-token-usage";
import {
	CHECKER_FORCED_FINAL_MARK,
	checkerFinalPrompt,
} from "../../src/domain/checker-brief";
import {
	type EfficiencySummary,
	efficiencySummary,
	type ModelSpendRow,
	type SpendSession,
	treeModelSpend,
} from "../../src/domain/eval-efficiency";
import {
	type Goal,
	goalCompactionNote,
	newGoal,
	nextGoalStep,
	withGoalNote,
} from "../../src/domain/goal";
import {
	harnessVariantLabel,
	leadReasoningEffort,
} from "../../src/domain/harness-variant";
import { SessionItemId, WorkspaceId } from "../../src/domain/ids";
import {
	modelBilling,
	openaiDirectCostUsd,
	usageCostUsd,
} from "../../src/domain/model-pricing";
import { newSidekickState } from "../../src/domain/sidekick";
import type { SubagentBudget } from "../../src/domain/subagent";
import { budgetTokenWeight } from "../../src/domain/subagent-usage";
import type { ContextArchiveStorage } from "../../src/server/adapters/context-archives";
import { stopApiTurnCommands } from "../../src/server/services/api-command-scope";
import { goalTool } from "../../src/server/services/goal-tool";
import {
	type ModelAgentRuntime,
	runModelAgent,
} from "../../src/server/services/model-agent-loop";
import { type PlanUpdate, planTool } from "../../src/server/services/plan-tool";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";
import {
	type AtifTrajectory,
	atifToolDefinitions,
	atifTrajectory,
	type TimedEvent,
	type TimedNotice,
} from "./atif";
import {
	BACKGROUND_GATE_MAX_ROUNDS,
	type BackgroundGateEntry,
	backgroundGate,
} from "./background-gate";
import { bedrockWebSearchUsd } from "./bedrock";
import {
	checkerWorkerTool,
	type FusionTrace,
	fusionLead,
	type RunRound,
	roundMessages,
} from "./children";
import {
	type BridgeRole,
	type HarborBridgeConfig,
	type HarborModel,
	routeProvider,
} from "./config";
import { effortMix } from "./effort-mix";
import { envSnapshot } from "./env-snapshot";
import { grindNotice } from "./grind-gate";
import {
	type HarborWorkspace,
	harborHarness,
	hostedWebSearchTools,
} from "./harness";
import { type HelperRole, helperTools, writesOutside } from "./helpers";
import {
	FINISH_CONTINUATIONS_MAX,
	type LedgerGateEntry,
	type LedgerState,
	ledgerGate,
	requirementsTool,
	withLedgerInstruction,
} from "./requirement-ledger";
import {
	briefFindingsPath,
	type CheckerRun,
	childBudgetUsed,
	childStepGuard,
	finalAnswer,
	harborReviewDeps,
	harborReviewLoop,
	lastChildText,
	type ReviewTrace,
	ranTranscript,
	reviewItems,
} from "./review";
import { describeRuntime } from "./runtime-description";
import {
	functionWebSearchTool,
	SEARCH_REQUEST_INSTRUCTIONS,
} from "./search-tool";
import {
	type ChildReport,
	type ChildSession,
	type TrialRole,
	trialSessions,
} from "./sessions";
import {
	guardedLanguageModel,
	recordTrialAlert,
	reserveTrial,
	SpendCapReached,
	settleTrial,
	trialSpendGuard,
} from "./spend";

/**
 * One Harbor trial of the current harness (docs/harbor-bridge-v2.md): spend
 * reservation, the product builder's tools and prompt, the model run, the
 * optional review loop, then the trace, the ATIF trajectory and the spend
 * settlement. Everything the outside world provides (the task container,
 * the model runtime, archive storage) is passed in, so the whole trial runs
 * offline in tests against a mock model and a fake container.
 */

export type HarborTrialInput = {
	config: HarborBridgeConfig;
	trialId: string;
	instruction: string;
	cwd: string;
	logsDir: string;
	/** When Harbor stops the agent (epoch ms), if known. */
	deadlineAt: number;
	machines: WorkspaceMachines;
	userId: string;
	storage: ContextArchiveStorage;
	/**
	 * Builds the route's runtime with every model request passed through
	 * `wrapModel`: the builder's model, or `model` (the checker's own,
	 * roleModels.checker) on the same route.
	 */
	runtime: (
		wrapModel: (model: LanguageModel) => LanguageModel,
		model?: HarborModel,
	) => Promise<ModelAgentRuntime>;
	mcpServers?: readonly string[];
	/**
	 * Checker-only (development; review=on): a tar of a saved run's final
	 * workspace in the sandbox. It is unpacked into the checkout after the
	 * review loop's baseline, no builder runs, and the checker reviews it once.
	 */
	restore?: string;
	harness: {
		name: string;
		version: string;
		commit: string | null;
		bundleSha256: string | null;
	};
	log?: (line: string) => void;
	now?: () => number;
	/** The background-command gate's poll interval (tests shorten it). */
	backgroundPollMs?: number;
};

export type HarborTrialResult = {
	/** Refused before any inference (a cap or the ledger's stop file). */
	refused: string | null;
	failure: string | null;
	usage: ApiTokenUsage | null;
	costUsd: number | null;
	requests: number;
	reviewRounds: number;
	/** AA-style cost block (src/domain/eval-efficiency.ts); null when refused. */
	efficiency: TrialEfficiency | null;
};

/**
 * The trial's cost block, from the shared eval-efficiency summary (the one
 * the hard-set runner prints): cost, tokens, model calls and cache hit rate,
 * split per role and model. Whether the task was solved is the grader's
 * call, so `solved` is not known here; aggregate trials with
 * evals/harbor_v2/efficiency.ts, which joins the verifier's reward.
 */
export type TrialEfficiency = Omit<
	EfficiencySummary,
	"solved" | "perSolvedUsd"
> & { readonly modelRows: readonly ModelSpendRow[] };

/** One usage record as a session's items, for treeModelSpend. */
function usageSession(
	session: Omit<SpendSession, "items">,
	usage: ApiTokenUsage | null,
): SpendSession {
	return {
		...session,
		items: usage
			? [
					{
						kind: "userMessage",
						id: SessionItemId(`${session.id}-usage`),
						text: "",
						apiUsage: usage,
					},
				]
			: [],
	};
}

/** The sidekick classifier's calls, one row per model (not a session in the product's tree). */
function classifierRows(input: {
	harness: "codex" | "api";
	children: readonly {
		role: TrialRole;
		modelId: string;
		usage: ApiTokenUsage | null;
	}[];
}): ModelSpendRow[] {
	const byModel = new Map<
		string,
		{ usage: ApiTokenUsage | null; agents: number }
	>();
	for (const child of input.children.filter(
		(entry) => entry.role === "classifier",
	)) {
		const row = byModel.get(child.modelId) ?? { usage: null, agents: 0 };
		row.usage = child.usage
			? addApiTokenUsage(row.usage, child.usage)
			: row.usage;
		row.agents++;
		byModel.set(child.modelId, row);
	}
	return [...byModel].map(([model, row]) => {
		const billing = modelBilling({ harness: input.harness, modelId: model });
		return {
			role: "classifier",
			model,
			agents: row.agents,
			requests: row.usage?.requests ?? 0,
			inputTokens: row.usage?.inputTokens ?? 0,
			outputTokens: row.usage?.outputTokens ?? 0,
			cacheReadTokens: row.usage?.cacheReadTokens ?? 0,
			costUsd: usageCostUsd(row.usage, billing),
			estimated: billing.kind === "plan",
		};
	});
}

export function trialEfficiency(input: {
	rootId: string;
	harness: "codex" | "api";
	builder: { modelId: string; usage: ApiTokenUsage | null };
	children: readonly {
		sessionId: string;
		role: TrialRole;
		modelId: string;
		usage: ApiTokenUsage | null;
	}[];
	seconds: number;
}): TrialEfficiency {
	const modelRows = treeModelSpend({
		rootId: input.rootId,
		sessions: [
			usageSession(
				{
					id: input.rootId,
					harness: input.harness,
					listedModelId: input.builder.modelId,
				},
				input.builder.usage,
			),
			...input.children
				.filter((child) => child.role !== "classifier")
				.map((child) =>
					usageSession(
						{
							id: child.sessionId,
							harness: input.harness,
							listedModelId: child.modelId,
							// Each role as the product's tree marks it (eval-efficiency.ts).
							agentRole:
								child.role === "sidekick" || child.role === "writer"
									? "writer"
									: child.role === "helper" || child.role === "search"
										? "researcher"
										: "checker",
							...(child.role === "sidekick"
								? { agentBudget: { sidekick: {} } as unknown as SubagentBudget }
								: child.role === "checkerWorker"
									? {
											agentRole: "writer" as const,
											agentBudget: {
												checkerPair: "worker",
											} as unknown as SubagentBudget,
										}
									: {}),
						},
						child.usage,
					),
				),
		],
	}).concat(classifierRows(input));
	const {
		solved: _solved,
		perSolvedUsd: _perSolved,
		...summary
	} = efficiencySummary([
		{ solved: false, seconds: input.seconds, models: modelRows },
	]);
	return { ...summary, modelRows };
}

/**
 * Why a root builder run started: a finish sent back by the background,
 * ledger or grind gate; null for the first run and a review fix.
 */
export type BuilderContinuation = "background" | "ledger" | "grind" | null;

/**
 * The root builder's effort for one run: the hook for an effort mix (for
 * example top effort for the runs a finish gate sends back). Every run keeps
 * the trial's effort today.
 */
export function builderRunEffort<Effort>(
	effort: Effort,
	_continuation: BuilderContinuation,
): Effort {
	return effort;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const sum = (usages: (ApiTokenUsage | null)[]) =>
	usages.reduce<ApiTokenUsage | null>(
		(total, usage) => (usage ? addApiTokenUsage(total, usage) : total),
		null,
	);

export function lastUsage(
	events: readonly TimedEvent[],
	from = 0,
	to = events.length,
): ApiTokenUsage | null {
	for (let index = to - 1; index >= from; index--) {
		const { event } = events[index];
		if (event.type === "usage") return event.usage;
	}
	return null;
}

/**
 * Usage events are cumulative within one model run; each review fix is a
 * new run whose counters start at zero. `starts` are the event indexes where
 * runs began.
 */
export function runsUsage(
	events: readonly TimedEvent[],
	starts: readonly number[],
): ApiTokenUsage | null {
	const bounds = starts.length ? starts : [0];
	return sum(
		bounds.map((start, index) =>
			lastUsage(events, start, bounds[index + 1] ?? events.length),
		),
	);
}

/** Where a reader's copy of the checkout goes (outside the checkout). */
/** A tool result carrying an image (the read tool's { image, base64 } output). */
export function isImageToolResult(event: unknown) {
	const e = event as { type?: unknown; output?: unknown } | null;
	if (e?.type !== "tool-result") return false;
	const output = e.output as { image?: unknown; base64?: unknown } | null;
	return (
		!!output &&
		typeof output === "object" &&
		typeof output.image === "string" &&
		typeof output.base64 === "string"
	);
}

export function readerCopyPath(trialId: string, sessionId: string) {
	const safe = (value: string) => value.replaceAll(/[^a-zA-Z0-9.-]/g, "");
	return `/tmp/ytimesy-readers/${safe(trialId)}/${safe(sessionId)}/checkout`;
}

/** Copies the checkout (with .git and the review refs) for a reader. */
export function readerCopyCommand(cwd: string, copy: string) {
	const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	return `rm -rf ${q(copy)} && mkdir -p "$(dirname ${q(copy)})" && cp -a ${q(cwd)} ${q(copy)}`;
}

function mcpNoteFor(servers: readonly string[] | undefined) {
	return servers?.length
		? ` MCP servers are available in this environment: ${servers.join(", ")}. Use them through a shell command: \`mcp-call <server> list\` lists a server's tools and arguments; \`mcp-call <server> call <tool> '<json arguments>'\` calls one. Each server keeps one session, so state such as an open browser page persists between calls.`
		: "";
}

export async function runHarborTrial(
	input: HarborTrialInput,
): Promise<HarborTrialResult> {
	const { config } = input;
	if (input.restore && config.variant.review !== "on")
		throw new Error("Checker-only (a restored workspace) needs review=on.");
	const now = input.now ?? Date.now;
	const log = input.log ?? (() => {});
	await mkdir(input.logsDir, { recursive: true });
	const tracePath = `${input.logsDir}/ytimesy-trace.json`;
	// A trace from another run in this directory would be mistaken for this trial's.
	if (
		await access(tracePath).then(
			() => true,
			() => false,
		)
	)
		throw new Error(
			`${tracePath} already exists; refusing to overwrite another trial's trace.`,
		);
	const startedAt = new Date(now()).toISOString();
	// Without a trial cap the trial may spend what the total leaves when it starts.
	let headroomUsd: number | null = null;
	if (config.total) {
		try {
			const reservation =
				config.trialUsdCap ?? config.trialReserveUsd ?? config.total.capUsd;
			const reserved = await reserveTrial({
				ledger: config.total.ledger,
				totalCapUsd: config.total.capUsd,
				trial: input.trialId,
				trialCapUsd: reservation,
			});
			if (config.trialUsdCap === null)
				headroomUsd = config.total.capUsd - reserved.committedUsd;
			for (const warning of reserved.warnings) log(`warning: ${warning}`);
		} catch (error) {
			if (error instanceof SpendCapReached)
				return {
					refused: error.message,
					failure: null,
					usage: null,
					costUsd: 0,
					requests: 0,
					reviewRounds: 0,
					efficiency: null,
				};
			throw error;
		}
	}
	const events: TimedEvent[] = [];
	// Event indexes where each builder run began (a review fix is a new run).
	const builderStarts: number[] = [];
	const notices: TimedNotice[] = [];
	const sessions = trialSessions(now);
	const readerCopies: { sessionId: string; copy: string; ok: boolean }[] = [];
	const fusionTrace: FusionTrace = {
		decisions: [],
		rounds: [],
		refused: [],
		restarts: [],
	};
	// lead=fusion: the lead's own calls at most at leadEffort (its sidekick keeps its own).
	const builderEffort =
		config.variant.lead === "fusion"
			? (leadReasoningEffort(config.effort, config.variant.leadEffort) ??
				config.effort)
			: config.effort;
	const builderModel: HarborModel = {
		modelId: config.modelId,
		effort: config.effort,
		billing: config.billing,
	};
	// roleModels.checker: the checker's own model on the route; else the builder's.
	const checkerModel = config.checker ?? builderModel;
	const totalUsage = () =>
		sum([
			runsUsage(events, builderStarts),
			...sessions.all().map((child) => runsUsage(child.events, child.starts)),
		]);
	// Each run at its own model's price (a cheaper checker counts less).
	const spendParts = () => [
		{
			usage: runsUsage(events, builderStarts),
			billing: config.billing,
			modelId: config.modelId,
		},
		...sessions.all().map((child) => ({
			usage: runsUsage(child.events, child.starts),
			billing: child.model.billing,
			modelId: child.model.modelId,
		})),
	];
	// Bedrock bills each Web Search query on top of tokens (builder and checkers).
	// search=function: agents' web_search calls are function calls (their
	// results are text); only each call's own request ran hosted searches.
	const searchUsd = () =>
		config.route === "bedrock"
			? bedrockWebSearchUsd(
					(config.variant.search === "function"
						? sessions.byRole("search").map((child) => child.events)
						: [events, ...sessions.all().map((child) => child.events)]
					).flatMap((list) => list.map((entry) => entry.event)),
				)
			: 0;
	const guard = trialSpendGuard({
		capUsd: config.trialUsdCap ?? headroomUsd,
		requestLimit: config.requestLimit,
		parts: spendParts,
		extraUsd: searchUsd,
	});
	let spendAlerted = false;
	const remainingMs = Math.max(1000, input.deadlineAt - now());
	const signal = AbortSignal.timeout(remainingMs);
	const workspace: HarborWorkspace = {
		machines: input.machines,
		vm: WorkspaceId("harbor"),
		cwd: input.cwd,
		signal,
		sessionId: input.trialId,
		turnId: harborTurnId(input.trialId),
	};
	let failure: string | null = null;
	let instructions = "";
	let tools = {};
	const reviewTrace: ReviewTrace = { checks: [] };
	const backgroundGates: BackgroundGateEntry[] = [];
	// ledger=on: the builder's requirement list and the gate's check runs.
	const ledger: LedgerState | null =
		config.variant.ledger === "on" ? { items: null, sets: [] } : null;
	const ledgerGates: LedgerGateEntry[] = [];
	let ledgerRounds = 0;
	// The root builder's first message: the request, with ledger=on's note;
	// under envSnapshot=on the sandbox's facts go above it.
	let firstMessage = ledger
		? withLedgerInstruction(input.instruction)
		: input.instruction;
	// Each root builder run and why it started (an effort mix keys on this).
	const builderRuns: {
		afterEvent: number;
		continuation: BuilderContinuation;
	}[] = [];
	let reviewRounds = 0;
	let reviewSummary: unknown = null;
	// goal=on: the request is the run's goal, held here outside the
	// transcript (src/domain/goal.ts); the builder marks it with the goal tool.
	const goalState: { goal: Goal } | null =
		config.variant.goal === "on" && !input.restore
			? {
					goal: newGoal({
						objective: input.instruction,
						deadlineAtMs: input.deadlineAt,
					}),
				}
			: null;
	// plan=on: every update_plan the root builder sent, for the trace.
	const planUpdates: PlanUpdate[] = [];
	try {
		const wrapModel = (model: LanguageModel) =>
			guardedLanguageModel(model, guard, signal);
		const runtime = await input.runtime(wrapModel);
		// The preflight's egress check reads `context window <n>` from this log.
		for (const line of describeRuntime(runtime, config)) log(line);
		// effortMix=on: the root builder's own requests plan and continue at the
		// turn's effort and execute at high (effort-mix.ts); children keep theirs.
		const mix = config.variant.effortMix === "on" ? effortMix(log) : null;
		const builderRuntime = mix
			? { ...runtime, model: mix.wrap(runtime.model) }
			: runtime;
		const provider = routeProvider(config.route);
		const onEvent = async (event: ApiAgentEvent) => {
			events.push({ at: new Date(now()).toISOString(), event });
			if (event.type === "tool-call")
				log(`tool ${event.name} ${JSON.stringify(event.input).slice(0, 160)}`);
			if (event.type === "usage") {
				const spent = guard.spentUsd();
				log(
					`usage in=${event.usage.inputTokens} out=${event.usage.outputTokens} usd=${spent.toFixed(4)}`,
				);
				if (
					config.trialAlertUsd !== null &&
					!spendAlerted &&
					spent >= config.trialAlertUsd
				) {
					spendAlerted = true;
					log(
						`spend alert: $${spent.toFixed(2)} passed the $${config.trialAlertUsd} alert; the trial keeps running`,
					);
					if (config.total)
						await recordTrialAlert({
							ledger: config.total.ledger,
							trial: input.trialId,
							usd: spent,
							thresholdUsd: config.trialAlertUsd,
						}).catch((error) =>
							log(
								`spend alert not recorded in the ledger: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
				}
			}
		};
		const runtimes = new Map<string, Promise<ModelAgentRuntime>>();
		const runtimeFor = (model: HarborModel) => {
			if (model.modelId === config.modelId && model.effort === config.effort)
				return Promise.resolve(runtime);
			const key = `${model.modelId}@${model.effort}`;
			let ready = runtimes.get(key);
			if (!ready) {
				ready = input.runtime(wrapModel, model);
				runtimes.set(key, ready);
			}
			return ready;
		};
		const roleModel = (role: BridgeRole) =>
			config.roles[role] ?? (role === "checker" ? checkerModel : builderModel);
		// search=function: each web_search call is its own low-effort request
		// with the hosted search tool, a child session so its tokens and
		// queries count in the trial's usage, cap and fees.
		const searchTool =
			config.webSearch && config.variant.search === "function"
				? functionWebSearchTool({
						search: async (query, callSignal) => {
							const model: HarborModel = { ...builderModel, effort: "low" };
							const hosted = hostedWebSearchTools(
								provider,
								config.route === "bedrock",
							);
							const session = sessions.add({
								role: "search",
								parentId: input.trialId,
								model,
								brief: query,
							});
							session.instructions = SEARCH_REQUEST_INSTRUCTIONS;
							session.tools = hosted;
							session.starts.push(session.events.length);
							log(`search ${session.id}: ${query.slice(0, 160)}`);
							const out = await runModelAgent(
								{
									userId: input.userId,
									modelId: model.modelId,
									reasoning: model.effort,
									toolSurface: "implementation",
									cacheScopeId: session.id,
									tools: hosted,
									instructions: SEARCH_REQUEST_INSTRUCTIONS,
									signal: AbortSignal.any([
										signal,
										AbortSignal.timeout(120_000),
										...(callSignal ? [callSignal] : []),
									]),
									maxSteps: 2,
									turnTimeoutMs: 120_000,
									messages: [{ role: "user", content: query }],
									onEvent: async (event) => {
										session.events.push({
											at: new Date(now()).toISOString(),
											event,
										});
									},
									onStep: async () => {},
								},
								await runtimeFor(model),
							);
							const answer = finalAnswer(out);
							session.reports.push({ outcome: "completed", report: answer });
							return answer;
						},
					})
				: undefined;
		const CHILD_BUDGET = { steps: 60, minutes: 15, tokens: 1_500_000 };
		// helpers=write: a writer implements a whole part of a long task.
		const WRITER_BUDGET = { steps: 150, minutes: 45, tokens: 4_000_000 };
		/** helpers=write: each writer's paths (its budget's sharedWriter). */
		const writerOwns = new Map<string, readonly string[]>();
		/** A cut-off checker's verdict: its brief, what it ran and its findings file, no tools. */
		const checkerLastWord = async (
			session: Parameters<RunRound>[0],
			brief: string,
			from: number,
		) => {
			const path = briefFindingsPath(brief);
			const findings = path
				? await input.machines
						.exec(
							workspace.vm,
							`tail -c 20000 '${path}' 2>/dev/null || true`,
							20_000,
						)
						.then((result) => result.stdout)
						.catch(() => "")
				: "";
			try {
				session.starts.push(session.events.length);
				const out = await runModelAgent(
					{
						userId: input.userId,
						modelId: session.model.modelId,
						reasoning: session.model.effort,
						toolSurface: "implementation",
						cacheScopeId: session.id,
						tools: {},
						instructions:
							"You are an independent checker whose time ran out. Give your verdict now.",
						signal: AbortSignal.any([signal, AbortSignal.timeout(75_000)]),
						maxSteps: 1,
						turnTimeoutMs: 75_000,
						messages: [
							{
								role: "user",
								content: checkerFinalPrompt({
									brief,
									ran: ranTranscript(session.events, from),
									findings,
								}),
							},
						],
						onEvent: async (event) => {
							session.events.push({ at: new Date(now()).toISOString(), event });
						},
						onStep: async () => {},
					},
					await runtimeFor(session.model),
				);
				return finalAnswer(out);
			} catch (error) {
				log(
					`checker ${session.id}: no forced final answer (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`,
				);
				return lastChildText(session.events, from);
			}
		};
		// One round of a child session (sidekick, checker, worker) in process,
		// on the same container: its harness, the product's role prompt.
		const runRound: RunRound = async (session, brief, options) => {
			const stop = new AbortController();
			const budget =
				session.role === "checker" || session.role === "checkerWorker"
					? (checkerBudgets.get(session.id) ?? CHILD_BUDGET)
					: session.role === "writer"
						? WRITER_BUDGET
						: CHILD_BUDGET;
			const childSignal = AbortSignal.any([
				signal,
				stop.signal,
				AbortSignal.timeout(budget.minutes * 60_000),
			]);
			session.stop = () => stop.abort(new Error("Stopped by its parent."));
			session.briefs.push(brief);
			// Each round runs under its own command scope: the round's end stops
			// its scope for good, so a scope shared by rounds would make every
			// later round's command exit 130 at once.
			const turnId = harborTurnId(session.id, session.briefs.length);
			const started = now();
			const checkerRole =
				session.role === "checker" || session.role === "checkerWorker";
			// The checker's forced final step (childStepGuard): tools off for it.
			let finalStep = false;
			const onChildEvent = async (event: ApiAgentEvent) => {
				session.events.push({ at: new Date(now()).toISOString(), event });
			};
			// The sidekick's state in its budget gives it the product's sidekick
			// role block (no commit, stash, reset or branch switch: publishing
			// stays the lead's) and the product's per-round token cap.
			const childBudget: SubagentBudget =
				session.role === "sidekick"
					? {
							...budget,
							sidekick: newSidekickState(budget, session.startedAt, {
								model: session.model.modelId,
							}),
						}
					: session.role === "writer"
						? {
								...budget,
								sharedWriter: { owns: writerOwns.get(session.id) ?? [] },
							}
						: budget;
			// A checker, helper or writer has the builder's execution access: web search and MCP too.
			const builderAccess =
				checkerRole || session.role === "helper" || session.role === "writer";
			const child = await harborHarness({
				workspace: {
					...workspace,
					cwd: options.cwd ?? input.cwd,
					signal: childSignal,
					sessionId: session.id,
					turnId,
				},
				userId: input.userId,
				modelId: session.model.modelId,
				provider,
				variant: config.variant,
				webSearch: config.webSearch && builderAccess,
				bedrock: config.route === "bedrock",
				...(searchTool ? { searchTool } : {}),
				...(builderAccess ? { mcpNote: mcpNoteFor(input.mcpServers) } : {}),
				instruction: brief,
				storage: input.storage,
				onEvent: onChildEvent,
				subagent: {
					role:
						options.agentRole ??
						(session.role === "sidekick" || session.role === "writer"
							? "writer"
							: "checker"),
					budget: childBudget,
					readOnly: options.readOnly,
				},
				...(options.extraTools ? { extraTools: options.extraTools } : {}),
			});
			session.instructions = child.instructions;
			session.tools = child.tools;
			const roundStart = session.events.length;
			const stepGuard = childStepGuard({
				role: session.role,
				budget: childBudget,
				startedAt: started,
				events: session.events,
				from: roundStart,
				weight: budgetTokenWeight(session.model.modelId, config.modelId),
				onFinalStep: () => {
					finalStep = true;
				},
			});
			session.starts.push(roundStart);
			try {
				const messages = await runModelAgent(
					{
						userId: input.userId,
						modelId: session.model.modelId,
						reasoning: session.model.effort,
						toolSurface: "implementation",
						cacheScopeId: session.id,
						...child.input,
						prepareMessages: async (history) =>
							stepGuard(
								(await child.input.prepareMessages?.(history)) ?? history,
							),
						tools: child.tools,
						instructions: child.instructions,
						signal: childSignal,
						maxSteps: budget.steps,
						turnTimeoutMs: budget.minutes * 60_000,
						...(session.role === "checker"
							? { toolsOff: () => finalStep }
							: {}),
						messages: roundMessages(session, brief),
						onEvent: onChildEvent,
						onStep: async () => {},
					},
					await runtimeFor(session.model),
				);
				session.messages = messages;
				const report = {
					outcome: "completed" as const,
					report: `${finalAnswer(messages)}${finalStep ? `\n${CHECKER_FORCED_FINAL_MARK}` : ""}`,
				};
				session.reports.push(report);
				return report;
			} catch (error) {
				// A checker cut off (time, stop, budget) before its answer: one
				// call without tools for the verdict from what it ran.
				if (session.role === "checker" && !signal.aborted) {
					const last = finalStep
						? lastChildText(session.events, roundStart)
						: "";
					const report = {
						outcome: "completed" as const,
						report: `${last || (await checkerLastWord(session, brief, roundStart))}\n${CHECKER_FORCED_FINAL_MARK}`,
					};
					log(
						`checker ${session.id} cut off (${error instanceof Error ? error.message.slice(0, 120) : String(error)}); forced final answer`,
					);
					session.reports.push(report);
					return report;
				}
				const used = childBudgetUsed(error);
				if (used) {
					log(`${session.role} ${session.id} stopped: ${used.message}`);
					// Its last text (a partial report or progress note) still reaches its parent.
					const report = {
						outcome: "failed" as const,
						report: lastChildText(session.events, roundStart),
						budgetUsed: used.reason,
					};
					session.reports.push(report);
					return report;
				}
				log(
					`${session.role} ${session.id} failed: ${error instanceof Error ? error.message : String(error)}${providerDetail(error)}`,
				);
				const report = { outcome: "failed" as const, report: "" };
				session.reports.push(report);
				return report;
			} finally {
				await stopApiTurnCommands(
					{
						machines: input.machines,
						vm: workspace.vm,
						cwd: options.cwd ?? input.cwd,
					},
					turnId,
				).catch(() => {});
			}
		};
		const checkerBudgets = new Map<
			string,
			{ steps: number; minutes: number; tokens: number }
		>();
		const startChecker = (spec: {
			sessionId: string;
			brief: string;
			budget: { steps: number; minutes: number; tokens: number };
		}): CheckerRun => {
			const session = sessions.add({
				role: "checker",
				parentId: input.trialId,
				id: spec.sessionId,
				model: checkerModel,
			});
			checkerBudgets.set(session.id, spec.budget);
			const pair = config.variant.checkerMode === "pair";
			// Readers never touch the checkout: the checker (and a pair judge's
			// workers) work in their own copy of it, the brief's paths moved there.
			const copy = readerCopyPath(input.trialId, session.id);
			const done = (async () => {
				const made = await input.machines.exec(
					workspace.vm,
					readerCopyCommand(input.cwd, copy),
					120_000,
				);
				readerCopies.push({
					sessionId: session.id,
					copy,
					ok: made.exitCode === 0,
				});
				if (made.exitCode !== 0) {
					log(
						`checker ${session.id}: no read copy (${made.stderr.slice(0, 200)})`,
					);
					const failed = { outcome: "failed" as const, report: "" };
					session.reports.push(failed);
					return failed;
				}
				return runRound(session, spec.brief.split(input.cwd).join(copy), {
					readOnly: true,
					cwd: copy,
					...(pair
						? {
								extraTools: () =>
									checkerWorkerTool({
										judge: session,
										sessions,
										model: (strong) =>
											strong ? checkerModel : roleModel("checkerWorker"),
										runRound: (worker, brief, options) => {
											checkerBudgets.set(worker.id, spec.budget);
											return runRound(worker, brief, { ...options, cwd: copy });
										},
									}),
							}
						: {}),
				});
			})();
			return {
				done,
				// Its rounds plus a forced final call, each a run of its own.
				usage: () => runsUsage(session.events, session.starts),
				stop: () => session.stop(),
			};
		};
		// helpers=on: a researcher or reviewer on its own copy of the checkout,
		// made at each round's start (the builder's work so far), as the checker's.
		// helpers=write's writer: in the builder's own checkout, limited by its
		// brief to `owns`; file writes outside them are logged, not blocked.
		const startHelper = async (
			session: ChildSession,
			role: HelperRole,
			brief: string,
			owns?: readonly string[],
		): Promise<ChildReport> => {
			if (role === "writer") {
				writerOwns.set(session.id, owns ?? []);
				const from = session.events.length;
				const report = await runRound(session, brief, {
					readOnly: false,
					agentRole: "writer",
				});
				const outside = writesOutside(
					session.events.slice(from).map((entry) => entry.event),
					input.cwd,
					owns ?? [],
				);
				if (outside.length)
					log(
						`writer ${session.id} wrote outside owns: ${outside.slice(0, 10).join(", ")}`,
					);
				return report;
			}
			const copy = readerCopyPath(input.trialId, session.id);
			const made = await input.machines.exec(
				workspace.vm,
				readerCopyCommand(input.cwd, copy),
				120_000,
			);
			readerCopies.push({
				sessionId: session.id,
				copy,
				ok: made.exitCode === 0,
			});
			if (made.exitCode !== 0) {
				log(
					`helper ${session.id}: no read copy (${made.stderr.slice(0, 200)})`,
				);
				const failed = { outcome: "failed" as const, report: "" };
				session.reports.push(failed);
				return failed;
			}
			return runRound(session, brief.split(input.cwd).join(copy), {
				readOnly: true,
				cwd: copy,
				agentRole: role,
			});
		};
		// lead=fusion: the builder is the lead, with one sidekick in its checkout.
		const lead =
			config.variant.lead === "fusion"
				? fusionLead({
						parentId: input.trialId,
						sessions,
						model: roleModel,
						escalation: config.roles.writerEscalation ?? null,
						runRound,
						callOnce: async (session, system, message) => {
							session.starts.push(session.events.length);
							const out = await runModelAgent(
								{
									userId: input.userId,
									modelId: session.model.modelId,
									reasoning: session.model.effort,
									toolSurface: "implementation",
									cacheScopeId: session.id,
									tools: {},
									instructions: system,
									signal,
									maxSteps: 1,
									turnTimeoutMs: 60_000,
									messages: [{ role: "user", content: message }],
									onEvent: async (event) => {
										session.events.push({
											at: new Date(now()).toISOString(),
											event,
										});
									},
									onStep: async () => {},
								},
								await runtimeFor(session.model),
							);
							return {
								text: finalAnswer(out),
								usage: runsUsage(session.events, session.starts),
							};
						},
						changedFiles: async () => {
							const status = await input.machines.exec(
								workspace.vm,
								`git -C ${JSON.stringify(input.cwd)} status --short`,
								20_000,
							);
							return status.stdout.split("\n").filter(Boolean).slice(0, 40);
						},
						trace: fusionTrace,
						thin: config.variant.leadTools === "thin",
						now,
					})
				: null;
		const harness = await harborHarness({
			workspace,
			userId: input.userId,
			modelId: config.modelId,
			provider,
			variant: config.variant,
			webSearch: config.webSearch,
			bedrock: config.route === "bedrock",
			...(searchTool ? { searchTool } : {}),
			// The first user message, with ledger=on's note: the request itself.
			instruction: firstMessage,
			storage: input.storage,
			onEvent,
			mcpNote: mcpNoteFor(input.mcpServers),
			...(config.variant.lead === "fusion"
				? { extraTools: () => lead?.tools() ?? {} }
				: {}),
			// The trial's own tools: ledger=on's requirements, goal=on's goal,
			// plan=on's update_plan, helpers=on's read-only subagents.
			trialTools: {
				...(config.variant.plan === "on"
					? planTool({
							now,
							onUpdate: (update) => {
								planUpdates.push(update);
								log(
									`plan update ${planUpdates.length}: ${update.plan.map((entry) => `[${entry.status}] ${entry.step.slice(0, 80)}`).join("; ")}`,
								);
							},
						})
					: {}),
				...(config.variant.helpers !== "off"
					? helperTools({
							writers: config.variant.helpers === "write",
							parentId: input.trialId,
							sessions,
							model: builderModel,
							start: startHelper,
							log,
						})
					: {}),
				...(ledger
					? requirementsTool({
							state: ledger,
							instruction: input.instruction,
							now,
							log,
						})
					: {}),
				...(goalState
					? goalTool({
							state: goalState,
							now,
							onUpdate: (goal) => {
								const claim = goal.claim;
								if (!claim) return;
								log(
									`goal update ${claim.status} (${claim.evidence.length} evidence)${claim.reason ? `: ${claim.reason.slice(0, 200)}` : ""}`,
								);
								claim.evidence.forEach((entry, index) => {
									log(
										`goal evidence ${index + 1}: ${entry.requirement.slice(0, 160)} => ${entry.proof.slice(0, 240)}`,
									);
								});
							},
						})
					: {}),
			},
		});
		instructions = harness.instructions;
		tools = harness.tools;
		const runBuilder = (
			messages: ModelMessage[],
			continuation: BuilderContinuation = null,
		) => {
			builderStarts.push(events.length);
			builderRuns.push({ afterEvent: events.length, continuation });
			return runModelAgent(
				{
					userId: input.userId,
					modelId: config.modelId,
					reasoning: builderRunEffort(builderEffort, continuation),
					toolSurface: "implementation",
					cacheScopeId: input.trialId,
					...harness.input,
					// The first message may carry more than the request (envSnapshot,
					// goal): it survives compaction as the person's request either way.
					isUserRequest: (message) =>
						message.role === "user" &&
						(message.content === input.instruction ||
							message.content === firstMessage),
					// goal=on: an active goal's objective follows every compaction.
					...(goalState
						? {
								compactionSnapshot: async (history, runSignal) =>
									[
										await harness.input
											.compactionSnapshot?.(history, runSignal)
											.catch(() => undefined),
										goalCompactionNote(goalState.goal),
									]
										.filter(Boolean)
										.join("\n\n") || undefined,
							}
						: {}),
					tools: harness.tools,
					instructions: harness.instructions,
					signal,
					maxSteps: config.requestLimit,
					turnTimeoutMs: remainingMs,
					messages,
					onEvent,
					onStep: async () => {},
				},
				builderRuntime,
			);
		};
		// The product wakes an idle chat when a background command exits
		// (background-command-notices.ts); here the root builder's run is
		// followed by a wait for the commands it left running and a
		// continuation with their exit notice (background-gate.ts).
		const runRootBuilder = async (
			history: ModelMessage[],
			continuation: BuilderContinuation = null,
		): Promise<ModelMessage[]> => {
			let out = await runBuilder(history, continuation);
			while (
				backgroundGates.filter((gate) => gate.outcome === "notified").length <
					BACKGROUND_GATE_MAX_ROUNDS &&
				!signal.aborted
			) {
				const gate = await backgroundGate({
					workspace: {
						machines: input.machines,
						vm: workspace.vm,
						cwd: input.cwd,
					},
					sessionId: workspace.sessionId,
					round: backgroundGates.length + 1,
					deadlineAt: input.deadlineAt,
					signal,
					now,
					...(input.backgroundPollMs !== undefined
						? { pollMs: input.backgroundPollMs }
						: {}),
				});
				if (gate.entry) {
					backgroundGates.push(gate.entry);
					log(
						`background gate ${gate.entry.round}: ${gate.entry.outcome} after ${gate.entry.waitedSeconds}s (${gate.entry.ids.join(", ")})${gate.entry.error ? `: ${gate.entry.error}` : ""}`,
					);
				}
				if (!gate.notice) break;
				notices.push({
					at: new Date(now()).toISOString(),
					afterEvent: events.length,
					text: gate.notice,
				});
				out = await runBuilder(
					[...out, { role: "user", content: gate.notice }],
					"background",
				);
			}
			// ledger=on: the harness runs the recorded checks on the finished
			// result and sends failures back (requirement-ledger.ts). Before
			// grind: a failing requirement is the more concrete notice.
			if (ledger && !signal.aborted) {
				const gate = await ledgerGate({
					state: ledger,
					cwd: input.cwd,
					exec: async (command, timeoutMs) => {
						const result = await input.machines.exec(
							workspace.vm,
							command,
							timeoutMs,
						);
						return {
							exitCode: result.exitCode,
							output: `${result.stdout}${result.stderr}`,
						};
					},
					rounds: ledgerRounds,
					runs: ledgerGates.length,
					deadlineAtMs: input.deadlineAt,
					now,
					signal,
					log,
				});
				if (gate.entry) ledgerGates.push(gate.entry);
				if (gate.notice) {
					ledgerRounds++;
					mix?.continuation();
					notices.push({
						at: new Date(now()).toISOString(),
						afterEvent: events.length,
						text: gate.notice,
						continuation: "ledger",
					});
					return runRootBuilder(
						[...out, { role: "user", content: gate.notice }],
						"ledger",
					);
				}
			}
			// goal=on: while the goal is active the builder goes back with the
			// audit notice, until it marks the goal or a deterministic stop
			// (src/domain/goal.ts). It supersedes grind: never both notices.
			if (goalState) {
				if (signal.aborted) return out;
				const { goal, step } = nextGoalStep(goalState.goal, {
					nowMs: now(),
					toolCalls:
						goalContinuedAt === null
							? null
							: events
									.slice(goalContinuedAt)
									.filter((entry) => entry.event.type === "tool-call").length,
				});
				goalState.goal = goal;
				if (step.kind === "stopped") return out;
				if (step.kind === "stop") {
					log(`goal stop ${step.reason}`);
					return out;
				}
				if (step.kind === "wrapUp")
					log(`goal stop ${step.reason} (wrap-up sent)`);
				else log(`goal continuation ${step.round}`);
				mix?.continuation();
				goalContinuedAt = events.length;
				notices.push({
					at: new Date(now()).toISOString(),
					afterEvent: events.length,
					text: step.text,
				});
				return runRootBuilder([...out, { role: "user", content: step.text }]);
			}
			// grind=on: an early finish with most of the time left goes back once
			// or twice to try to break the result (grind-gate.ts). With the
			// ledger on too, both share FINISH_CONTINUATIONS_MAX.
			if (
				config.variant.grind === "on" &&
				!signal.aborted &&
				(!ledger || ledgerRounds + grindRounds < FINISH_CONTINUATIONS_MAX)
			) {
				const notice = grindNotice({
					startedAtMs: Date.parse(startedAt),
					nowMs: now(),
					deadlineAtMs: input.deadlineAt,
					rounds: grindRounds,
				});
				if (notice) {
					grindRounds++;
					log(`grind ${grindRounds}: sent back after an early finish`);
					mix?.continuation();
					notices.push({
						at: new Date(now()).toISOString(),
						afterEvent: events.length,
						text: notice,
						continuation: "grind",
					});
					return runRootBuilder(
						[...out, { role: "user", content: notice }],
						"grind",
					);
				}
			}
			return out;
		};
		let grindRounds = 0;
		// Where the last goal continuation's run began, for its tool-call count.
		let goalContinuedAt: number | null = null;
		// envSnapshot=on: one read-only probe of the sandbox before the first
		// request (env-snapshot.ts); without it the request goes alone.
		if (config.variant.envSnapshot === "on" && !input.restore) {
			const snapshot = await envSnapshot({
				machines: input.machines,
				vm: workspace.vm,
				cwd: input.cwd,
			});
			log(
				snapshot
					? `env snapshot ${snapshot.length} chars`
					: "env snapshot failed; the request goes alone",
			);
			if (snapshot) firstMessage = `${snapshot}\n\n${firstMessage}`;
		}
		if (goalState) {
			firstMessage = withGoalNote(firstMessage);
			log("goal set");
		}
		let messages: ModelMessage[] = [{ role: "user", content: firstMessage }];
		// The request's exploration round, before the lead's first model call.
		if (lead)
			messages.push({
				role: "user",
				content: await lead.explore(input.instruction),
			});
		if (config.variant.review === "on") {
			const loop = harborReviewLoop({
				sessionId: input.trialId,
				turnId: workspace.turnId,
				workspace,
				signal,
				billing: config.billing,
				instruction: input.instruction,
				rigor: config.variant.rigor === "on",
				pair: config.variant.checkerMode === "pair",
				blind: config.variant.checkerMode === "blind",
				deps: harborReviewDeps({
					workspace,
					// Leave the grader's side two minutes.
					deadlineAt: input.deadlineAt - 120_000,
					startChecker,
					trace: reviewTrace,
					sessions,
					...(config.checker
						? {
								checkerModel: {
									harness:
										config.route === "codex-subscription" ? "codex" : "api",
									modelId: config.checker.modelId,
									reasoning: config.checker.effort,
								},
							}
						: {}),
					now,
				}),
			});
			const step = () => ({
				messages,
				items: reviewItems({
					instruction: input.instruction,
					usage: runsUsage(events, builderStarts),
					messages,
				}),
				waitUntil: input.deadlineAt - 120_000,
			});
			await loop.beforeModel(step());
			if (input.restore) {
				// Checker-only: the saved work lands after the baseline, so the
				// checker sees it as this run's change; one review, no builder.
				const unpacked = await input.machines.exec(
					workspace.vm,
					`tar -xf ${shellQuote(input.restore)} -C ${shellQuote(input.cwd)} && rm -f ${shellQuote(input.restore)}`,
					300_000,
				);
				if (unpacked.exitCode !== 0)
					throw new Error(
						`Restoring the saved workspace failed: ${unpacked.stderr.slice(0, 300)}`,
					);
				log(`checker-only: restored ${input.restore} into ${input.cwd}`);
				messages = [
					...messages,
					{ role: "assistant", content: "Done. The work is in the checkout." },
				];
				const outcome = await loop.afterAttempt(step());
				reviewSummary =
					outcome.kind === "finished" ? outcome.items.at(-1) : null;
				if (outcome.kind === "run") reviewRounds++;
				log(`checker-only: review outcome ${outcome.kind}`);
			}
			for (; !input.restore; ) {
				messages = await runRootBuilder(messages);
				const outcome = await loop.afterAttempt(step());
				if (outcome.kind !== "run" || !outcome.messages) {
					reviewSummary =
						outcome.kind === "finished" ? outcome.items.at(-1) : null;
					break;
				}
				reviewRounds++;
				const notice = outcome.messages.at(-1);
				notices.push({
					at: new Date(now()).toISOString(),
					afterEvent: events.length,
					text:
						typeof notice?.content === "string"
							? notice.content
							: JSON.stringify(notice?.content),
				});
				messages = outcome.messages;
				log(`review round ${reviewRounds}: findings returned to the builder`);
			}
		} else messages = await runRootBuilder(messages);
	} catch (error) {
		// A guard refusal surfaces from the model loop as a generic provider failure.
		failure =
			guard.stopReason() ??
			(error instanceof Error ? error.message : "Builder failed");
		log(`builder stopped: ${failure}`);
	} finally {
		await stopApiTurnCommands(
			{ machines: input.machines, vm: workspace.vm, cwd: input.cwd },
			workspace.turnId,
		).catch(() => {});
		for (const child of sessions.all()) child.stop();
	}
	const usage = totalUsage();
	// Each run at its own model's price; unknown when any price is unknown.
	const costUsd = spendParts().reduce<number | null>((total, part) => {
		if (total === null) return null;
		if (!part.usage) return total;
		const cost = usageCostUsd(part.usage, part.billing);
		return cost === null ? null : total + cost;
	}, searchUsd());
	// The same tokens at OpenAI's own billing (no Bedrock premium or
	// cache-write charge, no web search): comparable with Codex's Harbor jobs.
	// Not for a Bedrock trial that read images: Bedrock serves no cache hit to
	// a request that adds an image and counts each image at about 3x OpenAI's
	// tokens (measured 2026-10-27), so its token counts are not OpenAI's.
	const bedrockImages =
		config.route === "bedrock" &&
		[events, ...sessions.all().map((child) => child.events)].some((list) =>
			list.some((entry) => isImageToolResult(entry.event)),
		);
	const openaiDirectUsd = bedrockImages
		? null
		: spendParts().reduce<number | null>((total, part) => {
				if (total === null) return null;
				const cost = openaiDirectCostUsd(part.usage, part.modelId);
				return cost === null ? null : total + cost;
			}, 0);
	const efficiency = trialEfficiency({
		rootId: input.trialId,
		harness: config.route === "codex-subscription" ? "codex" : "api",
		builder: {
			modelId: config.modelId,
			usage: runsUsage(events, builderStarts),
		},
		children: sessions.all().map((child) => ({
			sessionId: child.id,
			role: child.role,
			modelId: child.model.modelId,
			usage: runsUsage(child.events, child.starts),
		})),
		seconds: (now() - Date.parse(startedAt)) / 1000,
	});
	const fingerprint = {
		trial: input.trialId,
		harness: input.harness,
		route: config.route,
		model: config.modelId,
		effort: config.effort,
		...(config.variant.lead === "fusion" ? { leadEffort: builderEffort } : {}),
		checkerModel: config.checker
			? { model: config.checker.modelId, effort: config.checker.effort }
			: null,
		variant: harnessVariantLabel(config.variant),
		billing: config.billing.kind,
		trialUsdCap: config.trialUsdCap,
		trialAlertUsd: config.trialAlertUsd,
		totalUsdCap: config.total?.capUsd ?? null,
		requestLimit: config.requestLimit,
		webSearch: config.webSearch,
	};
	await writeFile(
		tracePath,
		JSON.stringify({
			...fingerprint,
			startedAt,
			failure,
			requests: guard.requests(),
			usage,
			costUsd,
			openaiDirectUsd,
			efficiency,
			review: {
				rounds: reviewRounds,
				checks: reviewTrace.checks,
				readerCopies,
				state: reviewTrace.state ?? null,
				summary: reviewSummary,
			},
			events,
			notices,
			backgroundGates,
			builderRuns,
			ledger: ledger
				? {
						rounds: ledgerRounds,
						sets: ledger.sets,
						items: ledger.items,
						gates: ledgerGates,
					}
				: null,
			// goal=on: its final state, with the builder's claim and evidence.
			goal: goalState?.goal ?? null,
			// plan=on: each update_plan the root builder sent.
			plan: config.variant.plan === "on" ? planUpdates : null,
			fusion: config.variant.lead === "fusion" ? fusionTrace : null,
			roleModels: Object.fromEntries(
				Object.entries(config.roles).map(([role, model]) => [
					role,
					{ model: model.modelId, effort: model.effort },
				]),
			),
			checkers: sessions.all().map((child) => ({
				sessionId: child.id,
				role: child.role,
				parentId: child.parentId,
				model: child.model.modelId,
				effort: child.model.effort,
				brief: child.briefs[0] ?? "",
				briefs: child.briefs,
				events: child.events,
			})),
		}),
	);
	const toolDefinitions = await atifToolDefinitions(tools).catch(() => []);
	const subagents: AtifTrajectory[] = await Promise.all(
		sessions.all().map(async (checker) =>
			atifTrajectory({
				sessionId: input.trialId,
				trajectoryId: checker.id,
				agent: {
					name: `${input.harness.name}-${checker.role}`,
					version: input.harness.version,
				},
				modelName: checker.model.modelId,
				effort: checker.model.effort,
				billing: checker.model.billing,
				systemPrompt: checker.instructions || `(${checker.role})`,
				instruction: checker.briefs[0] ?? "",
				startedAt: checker.startedAt,
				events: checker.events,
				toolDefinitions: await atifToolDefinitions(checker.tools).catch(
					() => [],
				),
			}),
		),
	);
	const trajectory = atifTrajectory({
		sessionId: input.trialId,
		agent: {
			name: input.harness.name,
			version: input.harness.version,
			extra: fingerprint,
		},
		modelName: config.modelId,
		effort: config.effort,
		billing: config.billing,
		systemPrompt: instructions || "(not built)",
		instruction: firstMessage,
		startedAt,
		events,
		runStarts: builderStarts,
		notices,
		toolDefinitions,
		subagents,
		metricsExtra: {
			efficiency,
			...(goalState ? { goal: goalState.goal } : {}),
			...(config.variant.plan === "on" ? { plan: planUpdates } : {}),
		},
		...(failure ? { notes: `The builder stopped early: ${failure}` } : {}),
	});
	await writeFile(
		`${input.logsDir}/trajectory.json`,
		JSON.stringify(trajectory, null, 2),
	);
	if (config.total)
		for (const warning of (
			await settleTrial({
				ledger: config.total.ledger,
				trial: input.trialId,
				usd: costUsd ?? Number.NaN,
				totalCapUsd: config.total.capUsd,
			})
		).warnings)
			log(`warning: ${warning}`);
	return {
		refused: null,
		failure,
		usage,
		costUsd,
		requests: guard.requests(),
		reviewRounds,
		efficiency,
	};
}

/**
 * A turn id the product's command runner accepts (letters, digits and
 * hyphens, at most 80: api-command-scope.ts). Harbor trial ids carry
 * underscores (session-window-debug__MVgXW8D) and child ids a dot (.1);
 * used raw, every bash call failed with "Invalid command scope".
 */
export function harborTurnId(id: string, round?: number) {
	const suffix = `${round === undefined ? "" : `-r${round}`}-turn`;
	return `${id.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80 - suffix.length)}${suffix}`;
}

/**
 * The underlying provider error a SafeApiModelFailure keeps for operators
 * (its message is a generic classification), for the bridge log only:
 * name, message and cause chain, with AWS key ids and signatures redacted.
 */
export function providerDetail(error: unknown) {
	let inner = (error as { providerError?: unknown } | null)?.providerError;
	if (inner === undefined) return "";
	const parts: string[] = [];
	for (let depth = 0; depth < 4 && inner; depth++) {
		parts.push(
			inner instanceof Error
				? `${inner.name}: ${inner.message}`
				: (JSON.stringify(inner)?.slice(0, 400) ?? String(inner)),
		);
		inner = (inner as { cause?: unknown }).cause;
	}
	return ` [provider: ${parts
		.join(" <- ")
		.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, "<key>")
		.replace(/Signature=[0-9a-f]+/g, "Signature=<redacted>")
		.slice(0, 1200)}]`;
}
