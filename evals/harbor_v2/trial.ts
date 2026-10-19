import { access, mkdir, writeFile } from "node:fs/promises";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import {
	type ApiTokenUsage,
	addApiTokenUsage,
} from "../../src/domain/api-token-usage";
import {
	type EfficiencySummary,
	efficiencySummary,
	type ModelSpendRow,
	type SpendSession,
	treeModelSpend,
} from "../../src/domain/eval-efficiency";
import { harnessVariantLabel } from "../../src/domain/harness-variant";
import { SessionItemId, WorkspaceId } from "../../src/domain/ids";
import { usageCostUsd } from "../../src/domain/model-pricing";
import type { ContextArchiveStorage } from "../../src/server/adapters/context-archives";
import { stopApiTurnCommands } from "../../src/server/services/api-command-scope";
import {
	type ModelAgentRuntime,
	runModelAgent,
} from "../../src/server/services/model-agent-loop";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";
import {
	type AtifTrajectory,
	atifToolDefinitions,
	atifTrajectory,
	type TimedEvent,
	type TimedNotice,
} from "./atif";
import {
	API_ENDPOINTS,
	type HarborBridgeConfig,
	type HarborModel,
} from "./config";
import { type HarborWorkspace, harborHarness } from "./harness";
import {
	type CheckerRun,
	checkerStepGuard,
	finalAnswer,
	harborReviewDeps,
	harborReviewLoop,
	type ReviewTrace,
	reviewItems,
} from "./review";
import {
	guardedLanguageModel,
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
	harness: {
		name: string;
		version: string;
		commit: string | null;
		bundleSha256: string | null;
	};
	log?: (line: string) => void;
	now?: () => number;
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

export function trialEfficiency(input: {
	rootId: string;
	harness: "codex" | "api";
	builder: { modelId: string; usage: ApiTokenUsage | null };
	checkers: readonly {
		sessionId: string;
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
			...input.checkers.map((checker) =>
				usageSession(
					{
						id: checker.sessionId,
						harness: input.harness,
						listedModelId: checker.modelId,
						agentRole: "checker",
					},
					checker.usage,
				),
			),
		],
	});
	const {
		solved: _solved,
		perSolvedUsd: _perSolved,
		...summary
	} = efficiencySummary([
		{ solved: false, seconds: input.seconds, models: modelRows },
	]);
	return { ...summary, modelRows };
}

const sum = (usages: (ApiTokenUsage | null)[]) =>
	usages.reduce<ApiTokenUsage | null>(
		(total, usage) => (usage ? addApiTokenUsage(total, usage) : total),
		null,
	);

function lastUsage(
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

function mcpNoteFor(servers: readonly string[] | undefined) {
	return servers?.length
		? ` MCP servers are available in this environment: ${servers.join(", ")}. Use them through a shell command: \`mcp-call <server> list\` lists a server's tools and arguments; \`mcp-call <server> call <tool> '<json arguments>'\` calls one. Each server keeps one session, so state such as an open browser page persists between calls.`
		: "";
}

export async function runHarborTrial(
	input: HarborTrialInput,
): Promise<HarborTrialResult> {
	const { config } = input;
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
	if (config.total) {
		try {
			await reserveTrial({
				ledger: config.total.ledger,
				totalCapUsd: config.total.capUsd,
				trial: input.trialId,
				trialCapUsd: config.trialUsdCap ?? config.total.capUsd,
			});
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
	const checkerRuns: {
		sessionId: string;
		model: HarborModel;
		events: TimedEvent[];
		brief: string;
		instructions: string;
		tools: ToolSet;
		startedAt: string;
		run: CheckerRun;
	}[] = [];
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
			...checkerRuns.map((checker) => lastUsage(checker.events)),
		]);
	// Each run at its own model's price (a cheaper checker counts less).
	const spendParts = () => [
		{ usage: runsUsage(events, builderStarts), billing: config.billing },
		...checkerRuns.map((checker) => ({
			usage: lastUsage(checker.events),
			billing: checker.model.billing,
		})),
	];
	const guard = trialSpendGuard({
		capUsd: config.trialUsdCap,
		requestLimit: config.requestLimit,
		parts: spendParts,
	});
	const remainingMs = Math.max(1000, input.deadlineAt - now());
	const signal = AbortSignal.timeout(remainingMs);
	const workspace: HarborWorkspace = {
		machines: input.machines,
		vm: WorkspaceId("harbor"),
		cwd: input.cwd,
		signal,
		sessionId: input.trialId,
		turnId: `${input.trialId}-turn`,
	};
	let failure: string | null = null;
	let instructions = "";
	let tools = {};
	const reviewTrace: ReviewTrace = { checks: [] };
	let reviewRounds = 0;
	let reviewSummary: unknown = null;
	try {
		const wrapModel = (model: LanguageModel) =>
			guardedLanguageModel(model, guard, signal);
		const runtime = await input.runtime(wrapModel);
		// Built on the first check, only when the checker has its own model.
		let checkerRuntime: Promise<ModelAgentRuntime> | null = null;
		const runtimeForChecker = () => {
			if (!config.checker) return Promise.resolve(runtime);
			checkerRuntime ??= input.runtime(wrapModel, config.checker);
			return checkerRuntime;
		};
		const provider =
			config.route === "codex-subscription"
				? "codex-subscription"
				: API_ENDPOINTS[config.route].provider;
		const onEvent = async (event: ApiAgentEvent) => {
			events.push({ at: new Date(now()).toISOString(), event });
			if (event.type === "tool-call")
				log(`tool ${event.name} ${JSON.stringify(event.input).slice(0, 160)}`);
			if (event.type === "usage")
				log(
					`usage in=${event.usage.inputTokens} out=${event.usage.outputTokens} usd=${guard.spentUsd().toFixed(4)}`,
				);
		};
		const harness = await harborHarness({
			workspace,
			userId: input.userId,
			modelId: config.modelId,
			provider,
			variant: config.variant,
			webSearch: config.webSearch,
			instruction: input.instruction,
			storage: input.storage,
			onEvent,
			mcpNote: mcpNoteFor(input.mcpServers),
		});
		instructions = harness.instructions;
		tools = harness.tools;
		const runBuilder = (messages: ModelMessage[]) => {
			builderStarts.push(events.length);
			return runModelAgent(
				{
					userId: input.userId,
					modelId: config.modelId,
					reasoning: config.effort,
					toolSurface: "implementation",
					cacheScopeId: input.trialId,
					...harness.input,
					tools: harness.tools,
					instructions: harness.instructions,
					signal,
					maxSteps: config.requestLimit,
					turnTimeoutMs: remainingMs,
					messages,
					onEvent,
					onStep: async () => {},
				},
				runtime,
			);
		};
		const startChecker = (spec: {
			sessionId: string;
			brief: string;
			budget: { steps: number; minutes: number; tokens: number };
		}): CheckerRun => {
			const stop = new AbortController();
			const checkerSignal = AbortSignal.any([
				signal,
				stop.signal,
				AbortSignal.timeout(spec.budget.minutes * 60_000),
			]);
			const checkerEvents: TimedEvent[] = [];
			const started = now();
			const entry = {
				sessionId: spec.sessionId,
				model: checkerModel,
				events: checkerEvents,
				brief: spec.brief,
				instructions: "",
				tools: {} as ToolSet,
				startedAt: new Date(started).toISOString(),
				run: null as unknown as CheckerRun,
			};
			const done = (async () => {
				const checkerRuntimeReady = runtimeForChecker();
				const checker = await harborHarness({
					workspace: {
						...workspace,
						signal: checkerSignal,
						sessionId: spec.sessionId,
						turnId: `${spec.sessionId}-turn`,
					},
					userId: input.userId,
					modelId: checkerModel.modelId,
					provider,
					variant: config.variant,
					webSearch: false,
					instruction: spec.brief,
					storage: input.storage,
					onEvent: async (event) => {
						checkerEvents.push({ at: new Date(now()).toISOString(), event });
					},
					subagent: { role: "checker", budget: spec.budget },
				});
				entry.instructions = checker.instructions;
				entry.tools = checker.tools;
				const stepGuard = checkerStepGuard({
					budget: spec.budget,
					startedAt: started,
					usage: () => lastUsage(checkerEvents),
				});
				try {
					const messages = await runModelAgent(
						{
							userId: input.userId,
							modelId: checkerModel.modelId,
							reasoning: checkerModel.effort,
							toolSurface: "implementation",
							cacheScopeId: spec.sessionId,
							...checker.input,
							prepareMessages: async (history) =>
								stepGuard(
									(await checker.input.prepareMessages?.(history)) ?? history,
								),
							tools: checker.tools,
							instructions: checker.instructions,
							signal: checkerSignal,
							maxSteps: spec.budget.steps,
							turnTimeoutMs: spec.budget.minutes * 60_000,
							messages: [{ role: "user", content: spec.brief }],
							onEvent: async (event) => {
								checkerEvents.push({
									at: new Date(now()).toISOString(),
									event,
								});
							},
							onStep: async () => {},
						},
						await checkerRuntimeReady,
					);
					return {
						outcome: "completed" as const,
						report: finalAnswer(messages),
					};
				} catch (error) {
					log(
						`checker ${spec.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return { outcome: "failed" as const, report: "" };
				} finally {
					await stopApiTurnCommands(
						{ machines: input.machines, vm: workspace.vm, cwd: input.cwd },
						`${spec.sessionId}-turn`,
					).catch(() => {});
				}
			})();
			entry.run = {
				done,
				usage: () => lastUsage(checkerEvents),
				stop: () => stop.abort(new Error("Review loop stopped the checker.")),
			};
			checkerRuns.push(entry);
			return entry.run;
		};
		let messages: ModelMessage[] = [
			{ role: "user", content: input.instruction },
		];
		if (config.variant.review === "on") {
			const loop = harborReviewLoop({
				sessionId: input.trialId,
				turnId: workspace.turnId,
				workspace,
				signal,
				billing: config.billing,
				instruction: input.instruction,
				deps: harborReviewDeps({
					workspace,
					// Leave the grader's side two minutes.
					deadlineAt: input.deadlineAt - 120_000,
					startChecker,
					trace: reviewTrace,
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
			for (;;) {
				messages = await runBuilder(messages);
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
		} else messages = await runBuilder(messages);
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
		for (const checker of checkerRuns) checker.run?.stop();
	}
	const usage = totalUsage();
	// Each run at its own model's price; unknown when any price is unknown.
	const costUsd = spendParts().reduce<number | null>((total, part) => {
		if (total === null) return null;
		if (!part.usage) return total;
		const cost = usageCostUsd(part.usage, part.billing);
		return cost === null ? null : total + cost;
	}, 0);
	const efficiency = trialEfficiency({
		rootId: input.trialId,
		harness: config.route === "codex-subscription" ? "codex" : "api",
		builder: {
			modelId: config.modelId,
			usage: runsUsage(events, builderStarts),
		},
		checkers: checkerRuns.map((checker) => ({
			sessionId: checker.sessionId,
			modelId: checker.model.modelId,
			usage: lastUsage(checker.events),
		})),
		seconds: (now() - Date.parse(startedAt)) / 1000,
	});
	const fingerprint = {
		trial: input.trialId,
		harness: input.harness,
		route: config.route,
		model: config.modelId,
		effort: config.effort,
		checkerModel: config.checker
			? { model: config.checker.modelId, effort: config.checker.effort }
			: null,
		variant: harnessVariantLabel(config.variant),
		billing: config.billing.kind,
		trialUsdCap: config.trialUsdCap,
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
			efficiency,
			review: {
				rounds: reviewRounds,
				checks: reviewTrace.checks,
				state: reviewTrace.state ?? null,
				summary: reviewSummary,
			},
			events,
			notices,
			checkers: checkerRuns.map(({ sessionId, model, events, brief }) => ({
				sessionId,
				model: model.modelId,
				effort: model.effort,
				brief,
				events,
			})),
		}),
	);
	const toolDefinitions = await atifToolDefinitions(tools).catch(() => []);
	const subagents: AtifTrajectory[] = await Promise.all(
		checkerRuns.map(async (checker) =>
			atifTrajectory({
				sessionId: input.trialId,
				trajectoryId: checker.sessionId,
				agent: {
					name: `${input.harness.name}-checker`,
					version: input.harness.version,
				},
				modelName: checker.model.modelId,
				effort: checker.model.effort,
				billing: checker.model.billing,
				systemPrompt: checker.instructions || "(checker)",
				instruction: checker.brief,
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
		instruction: input.instruction,
		startedAt,
		events,
		runStarts: builderStarts,
		notices,
		toolDefinitions,
		subagents,
		metricsExtra: { efficiency },
		...(failure ? { notes: `The builder stopped early: ${failure}` } : {}),
	});
	await writeFile(
		`${input.logsDir}/trajectory.json`,
		JSON.stringify(trajectory, null, 2),
	);
	if (config.total)
		await settleTrial({
			ledger: config.total.ledger,
			trial: input.trialId,
			usd: costUsd ?? Number.NaN,
		});
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
