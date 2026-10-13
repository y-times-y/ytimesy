import { generateText, type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import { type ApiTokenUsage, addApiTokenUsage } from "#/domain/api-token-usage";
import {
	type ModelAgentInput,
	type ModelAgentRuntime,
	runModelAgent,
} from "./model-agent-loop";

/**
 * Fusion, as [competitor] describes it (cognition.com/blog/[competitor]-fusion and
 * /blog/local-fusion):
 * - "two parallel agents: one with a frontier model, the other with a more
 *   cost-effective 'sidekick' model. Both are fully capable agents with their
 *   own toolsets and ability to gather & act on their own context."
 * - "the main agent decides which tasks to give the sidekick and which tasks
 *   to do itself ... take minimal actions, and only read what is absolutely
 *   necessary. By default it should delegate and monitor, while making the
 *   significant decisions: the plan, the interpretation of ambiguity, the
 *   final review."
 * - "It hands the sidekick a brief of each task it delegates, with constraints
 *   and success criteria. The sidekick explores code, implements changes, runs
 *   tests, and reports back."
 * - "the lead and sidekick only exchange briefs, results, and feedback ...
 *   Each agent builds its own persistent context."
 * - "The lead always reviews the work, identifies problems, and can take
 *   control back when the sidekick is out of its depth."
 * - "we use lightweight classifiers during task execution to signal when we
 *   need to switch to the main agent or use a different model entirely ... by
 *   switching the model during context compaction."
 * - Per-pair tuning: how prescriptive briefs are, whether the sidekick may push
 *   back, and which exploration is delegated.
 */

type FusionPairTuning = {
	/** "Paired with a weaker sidekick, [the lead] needs to provide more prescriptive briefs." */
	readonly prescriptiveBriefs: boolean;
	/** "With stronger sidekicks, encouraging pushback can help catch mistakes in the lead's plan." */
	readonly sidekickPushback: boolean;
	/** "exploration needed for planning should not be delegated to a weaker sidekick." */
	readonly delegateInitialExploration: boolean;
};

const STRONG: FusionPairTuning = {
	prescriptiveBriefs: false,
	sidekickPushback: true,
	delegateInitialExploration: true,
};
const WEAK: FusionPairTuning = {
	prescriptiveBriefs: true,
	sidekickPushback: false,
	delegateInitialExploration: false,
};
/** Tuned per sidekick model; unknown models get the conservative (weak) policy. */
const FUSION_PAIR_TUNING: Record<string, FusionPairTuning> = {
	"gpt-6.1-sol": STRONG,
	"gpt-6-astra": STRONG,
	"gpt-6-sol": STRONG,
	"gpt-5.6-sol": STRONG,
	"gpt-5.6-terra": WEAK,
	"gpt-6-luna": WEAK,
	"gpt-5.6-luna": WEAK,
};
const fusionTuning = (sidekickModelId: string) =>
	FUSION_PAIR_TUNING[sidekickModelId] ?? WEAK;

export type FusionConfig = {
	readonly sidekickModelId: string;
	/** Model the classifier may switch the sidekick to at compaction. */
	readonly upgradeModelId: string;
	/** Lightweight classifier model. */
	readonly classifierModelId: string;
	/** Sidekick steps between classifier checks during execution. */
	readonly classifyEverySteps?: number;
};

export type SidekickState = {
	modelId: string;
	messages: ModelMessage[];
};

function fusionLeadInstructions(config: FusionConfig) {
	const tuning = fusionTuning(config.sidekickModelId);
	return [
		"Fusion lead: you and a cost-effective sidekick are both fully capable agents with your own tools and context, working in the same workspace.",
		"You decide which tasks to give the sidekick and which tasks to do yourself. Take minimal actions and only read what is absolutely necessary. By default, delegate and monitor, while you make the significant decisions: the plan, the interpretation of ambiguity, and the final review.",
		`Hand the sidekick a brief for each task you delegate with delegate_to_sidekick: the task, its constraints and its success criteria. ${tuning.prescriptiveBriefs ? "This sidekick needs prescriptive briefs: name the files, approach and checks." : "This sidekick can decide implementation details itself; brief the goal, constraints and success criteria."} ${tuning.delegateInitialExploration ? "You may delegate initial exploration." : "Do the exploration needed for planning yourself; do not delegate it."}`,
		"Each round trip costs time and tokens: by default give one complete brief per task (explore, implement, verify) with a step_budget that fits it, and split exploration from implementation only when a decision genuinely needs you. Do not repeat reading the sidekick is doing.",
		"Exchange only briefs, results and feedback: wait_for_sidekick returns its result or its progress, message_sidekick sends feedback (also while it works, to steer it). Always review the sidekick's work yourself in the workspace (for example with git diff and the required checks) against the user's original request, and identify problems. When the sidekick is out of its depth, take_control and finish the work yourself.",
		"While the sidekick is working, the workspace belongs to it: wait, send feedback, or take control before changing files or running commands. The user only talks to you; your final answer reports what was done and verified.",
	].join(" ");
}

function fusionSidekickInstructions(config: FusionConfig) {
	const tuning = fusionTuning(config.sidekickModelId);
	return [
		"Fusion sidekick: you are a fully capable agent with your own tools and context. The lead delegates tasks to you with a brief of constraints and success criteria.",
		"Explore the code, implement the changes, run the tests, and report back within your step budget. Your final message is your report to the lead: what you changed, the exact commands you ran with their results, and anything unresolved.",
		tuning.sidekickPushback
			? "If the brief conflicts with what you find in the code, push back in your report with the evidence."
			: "Follow the brief; report blockers instead of changing the plan.",
	].join(" ");
}

type ClassifierDecision = {
	decision: "continue" | "switch_model" | "return_to_lead";
	reason: string;
};

const classifierSchema = z.object({
	decision: z.enum(["continue", "switch_model", "return_to_lead"]),
	reason: z.string().max(500),
});

/** A compact view of recent sidekick work for the lightweight classifier. */
function recentWork(events: readonly ApiAgentEvent[]) {
	return events
		.slice(-40)
		.map((event) => {
			if (event.type === "tool-call")
				return `call ${event.name} ${JSON.stringify(event.input).slice(0, 160)}`;
			if (event.type === "tool-result")
				return `result ${event.name}${event.failed ? " FAILED" : ""} ${JSON.stringify(event.output).slice(0, 200)}`;
			return null;
		})
		.filter(Boolean)
		.join("\n");
}

async function classifySidekick(
	runtime: ModelAgentRuntime,
	brief: string,
	events: readonly ApiAgentEvent[],
	signal: AbortSignal,
	progress?: { steps: number; budget: number },
): Promise<ClassifierDecision> {
	const { text } = await generateText({
		model: runtime.model,
		abortSignal: signal,
		maxRetries: 1,
		prompt: `You monitor a coding sidekick. Decide whether it should continue, switch to a stronger model, or hand the task back to the lead because it is out of its depth (stalled, repeating failures, or working against the brief). Reply with JSON only: {"decision":"continue"|"switch_model"|"return_to_lead","reason":"..."}.${progress ? ` It has used ${progress.steps} of a ${progress.budget}-step budget; hand back when it is near the budget without converging on a result.` : ""}\n\nBrief:\n${brief.slice(0, 4000)}\n\nRecent work:\n${recentWork(events)}`,
	});
	const json = /\{[\s\S]*\}/.exec(text)?.[0];
	const parsed = json ? classifierSchema.safeParse(JSON.parse(json)) : null;
	return parsed?.success
		? parsed.data
		: { decision: "continue", reason: "unclear classifier output" };
}

type SidekickRun = {
	brief: string;
	status: "running" | "done" | "returned" | "stopped" | "failed";
	report?: string;
	promise: Promise<void>;
	abort: AbortController;
	/** What the lead sees while monitoring. */
	steps: number;
	budget: number;
	recent: string[];
	note?: string;
	/** Lead feedback delivered at the sidekick's next step. */
	feedback: string[];
};

const DEFAULT_STEP_BUDGET = 40;
/** Steps past the budget before an unreported run is handed back. */
const BUDGET_GRACE = 6;

/** Thrown inside the sidekick loop to stop it for a model switch or hand-back. */
class SidekickInterrupt extends Error {
	constructor(
		readonly kind: "switch_model" | "return_to_lead",
		readonly reason: string,
	) {
		super(reason);
	}
}

/** The loop may wrap an interrupt (SDK step errors, SafeApiModelFailure.providerError). */
function sidekickInterrupt(error: unknown): SidekickInterrupt | null {
	for (let current = error, depth = 0; current && depth < 6; depth++) {
		if (current instanceof SidekickInterrupt) return current;
		if (typeof current !== "object") return null;
		const record = current as { providerError?: unknown; cause?: unknown };
		current = record.providerError ?? record.cause;
	}
	return null;
}

function lastText(messages: readonly ModelMessage[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * Runs one Fusion lead turn. The lead loop owns the user's conversation; the
 * sidekick keeps its own persistent context (sidekick.messages) across briefs.
 */
export async function runFusionAgent(input: {
	lead: ModelAgentInput;
	leadRuntime: ModelAgentRuntime;
	/** The shared workspace tool surface both agents use. */
	workspaceTools: ToolSet;
	config: FusionConfig;
	makeRuntime: (modelId: string, effort: string) => Promise<ModelAgentRuntime>;
	sidekick: SidekickState;
	saveSidekick: (state: SidekickState) => Promise<void>;
	/** Sidekick events; usage is cumulative across every sidekick run this turn. */
	onSidekickEvent: (event: ApiAgentEvent) => Promise<void>;
	/** Called before every sidekick model request (shared limits). */
	beforeSidekickRequest?: () => Promise<void>;
}) {
	const { config } = input;
	const sidekick = input.sidekick;
	let current: SidekickRun | undefined;
	const sidekickEvents: ApiAgentEvent[] = [];
	const every = config.classifyEverySteps ?? 8;
	// Each runModelAgent reports usage from zero; carry earlier runs forward.
	let usageBase: ApiTokenUsage | null = null;
	let runUsage: ApiTokenUsage | null = null;
	const settleUsage = () => {
		if (runUsage) usageBase = addApiTokenUsage(usageBase, runUsage);
		runUsage = null;
	};

	async function runSidekick(
		brief: string,
		opening: ModelMessage,
		budget = DEFAULT_STEP_BUDGET,
	) {
		const abort = new AbortController();
		const run: SidekickRun = {
			brief,
			status: "running",
			abort,
			promise: Promise.resolve(),
			steps: 0,
			budget,
			recent: [],
			feedback: [],
		};
		// Whatever the sidekick learned, for reports that end without its own.
		const partial = () =>
			[
				run.note ? `Its latest notes:\n${run.note.slice(0, 2000)}` : "",
				run.recent.length ? `Its last actions:\n${run.recent.join("\n")}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
		let budgetNoticed = false;
		run.promise = (async () => {
			let messages: ModelMessage[] = [...sidekick.messages, opening];
			let pendingSwitch: string | undefined;
			let steps = 0;
			for (let segment = 0; segment < 3; segment++) {
				const runtime = await input.makeRuntime(sidekick.modelId, "max");
				const classifier = await input.makeRuntime(
					config.classifierModelId,
					"low",
				);
				try {
					messages = await runModelAgent(
						{
							// Only what the sidekick needs: never the lead's stateful turn hooks.
							userId: input.lead.userId,
							turnTimeoutMs: input.lead.turnTimeoutMs,
							toolSurface: "implementation",
							modelId: sidekick.modelId,
							instructions: fusionSidekickInstructions(config),
							tools: input.workspaceTools,
							messages,
							cacheScopeId: `${input.lead.cacheScopeId ?? "fusion"}:sidekick`,
							signal: AbortSignal.any([input.lead.signal, abort.signal]),
							onEvent: async (event) => {
								sidekickEvents.push(event);
								if (event.type === "tool-call")
									run.recent = [
										...run.recent,
										`${event.name} ${JSON.stringify(event.input).slice(0, 140)}`,
									].slice(-6);
								if (event.type === "usage") {
									runUsage = event.usage;
									event = {
										...event,
										usage: addApiTokenUsage(usageBase, event.usage),
									};
								}
								await input.onSidekickEvent(event);
							},
							// Before each sidekick request: shared limits, then the lightweight
							// classifier every few steps (a thrown hand-back stops the loop here).
							beforeStep: async () => {
								await input.beforeSidekickRequest?.();
								if (steps >= run.budget + BUDGET_GRACE)
									throw new SidekickInterrupt(
										"return_to_lead",
										`it passed its ${run.budget}-step budget without reporting`,
									);
								if (steps === 0 || steps % every !== 0) return;
								const decision = await classifySidekick(
									classifier,
									brief,
									sidekickEvents,
									input.lead.signal,
									{ steps, budget: run.budget },
								);
								if (decision.decision === "return_to_lead")
									throw new SidekickInterrupt(
										"return_to_lead",
										decision.reason,
									);
								if (decision.decision === "switch_model")
									pendingSwitch = decision.reason;
							},
							onStep: async (history) => {
								steps++;
								run.steps = steps;
								run.note = lastText(history) || run.note;
								messages = history;
								sidekick.messages = history;
							},
							// Lead feedback and the budget notice arrive between steps.
							prepareMessages: async (history) => {
								const injected: ModelMessage[] = run.feedback
									.splice(0)
									.map((text) => ({
										role: "user",
										content: `Feedback from the lead while you work:\n${text}`,
									}));
								if (steps >= run.budget && !budgetNoticed) {
									budgetNoticed = true;
									injected.push({
										role: "user",
										content: `You have reached your ${run.budget}-step budget. Stop and send your report now: what you found, what you changed, the commands you ran with their results, and what is left.`,
									});
								}
								return injected.length ? [...history, ...injected] : history;
							},
							// Model switches happen at compaction, which discards the cache anyway.
							beforeCompaction: async () => {
								const decision = pendingSwitch
									? { decision: "switch_model" as const, reason: pendingSwitch }
									: await classifySidekick(
											classifier,
											brief,
											sidekickEvents,
											input.lead.signal,
										);
								if (
									decision.decision === "switch_model" &&
									sidekick.modelId !== config.upgradeModelId
								)
									throw new SidekickInterrupt("switch_model", decision.reason);
								if (decision.decision === "return_to_lead")
									throw new SidekickInterrupt(
										"return_to_lead",
										decision.reason,
									);
							},
						},
						runtime,
					);
					settleUsage();
					sidekick.messages = messages;
					await input.saveSidekick(sidekick);
					run.status = "done";
					run.report =
						lastText(messages) || "The sidekick finished without a report.";
					return;
				} catch (caught) {
					settleUsage();
					// Completed steps survive a stop or hand-back; the workspace has the rest.
					sidekick.messages = messages;
					await input.saveSidekick(sidekick).catch(() => {});
					const error = sidekickInterrupt(caught);
					if (!error) {
						if (abort.signal.aborted) {
							run.status = "stopped";
							run.report = "The lead took control; the sidekick stopped.";
						} else {
							run.status = "failed";
							run.report = [
								`The sidekick failed: ${caught instanceof Error ? caught.message : "unknown error"}`,
								partial(),
							]
								.filter(Boolean)
								.join("\n\n");
						}
						return;
					}
					if (error.kind === "return_to_lead") {
						run.status = "returned";
						run.report = [
							`The sidekick handed the task back: ${error.reason}. Its work so far is in the workspace.`,
							partial(),
						]
							.filter(Boolean)
							.join("\n\n");
						return;
					}
					// Switch model: continue from a summary, since provider reasoning
					// state does not carry across models.
					const summary = lastText(messages);
					sidekick.modelId = config.upgradeModelId;
					messages = [
						{
							role: "user",
							content: `${brief}\n\nProgress so far (you are continuing this task after a model switch; verify against the workspace): ${summary || "see the workspace and git diff."}`,
						},
					];
					sidekick.messages = messages;
					await input.saveSidekick(sidekick);
				}
			}
			run.status = "failed";
			run.report = "The sidekick did not finish after model switches.";
		})();
		current = run;
		return run;
	}

	const sidekickActive = () => current?.status === "running";
	// One editor at a time: the lead's workspace tools pause while the sidekick works.
	const leadWorkspaceTools: ToolSet = Object.fromEntries(
		Object.entries(input.workspaceTools).map(([name, definition]) => [
			name,
			{
				...definition,
				execute: definition.execute
					? (
							args: unknown,
							options: Parameters<NonNullable<typeof definition.execute>>[1],
						) =>
							sidekickActive() &&
							![
								"read_repository_guidance",
								"read_environment_report",
								"view_image",
							].includes(name)
								? Promise.resolve({
										blocked: true,
										error:
											"The sidekick is working in the workspace. Use wait_for_sidekick, message_sidekick, or take_control first.",
									})
								: (
										definition.execute as (
											a: unknown,
											o: unknown,
										) => Promise<unknown>
									)(args, options)
					: undefined,
			},
		]),
	) as ToolSet;

	const fusionTools: ToolSet = {
		delegate_to_sidekick: tool({
			description:
				"Delegate a task to the sidekick with a brief: the task, its constraints and its success criteria. The sidekick explores, implements, runs tests and reports back.",
			inputSchema: z.object({
				task: z.string().min(1).max(4000),
				constraints: z.array(z.string().max(500)).max(12),
				success_criteria: z.array(z.string().max(500)).min(1).max(12),
				step_budget: z
					.number()
					.int()
					.min(5)
					.max(120)
					.default(DEFAULT_STEP_BUDGET)
					.describe("Tool steps the sidekick may use before it must report."),
			}),
			execute: async ({ task, constraints, success_criteria, step_budget }) => {
				if (sidekickActive())
					return {
						error:
							"The sidekick is still working. Wait, send feedback, or take control.",
					};
				const brief = [
					`Task: ${task}`,
					constraints.length
						? `Constraints:\n${constraints.map((line) => `- ${line}`).join("\n")}`
						: "",
					`Success criteria:\n${success_criteria.map((line) => `- ${line}`).join("\n")}`,
				]
					.filter(Boolean)
					.join("\n\n");
				const budget = step_budget ?? DEFAULT_STEP_BUDGET;
				await runSidekick(
					`${brief}\n\nStep budget: report within ${budget} tool steps.`,
					{
						role: "user",
						content: `${brief}\n\nStep budget: report within ${budget} tool steps.`,
					},
					budget,
				);
				return { delegated: true, model: sidekick.modelId, budget };
			},
		}),
		wait_for_sidekick: tool({
			description:
				"Monitor the sidekick: wait up to the given seconds; returns its report when done, otherwise its progress (steps used, recent actions, latest notes).",
			inputSchema: z.object({
				seconds: z.number().int().min(1).max(600).default(300),
			}),
			execute: async ({ seconds = 300 }) => {
				const run = current;
				if (!run) return { status: "idle" };
				await Promise.race([
					run.promise,
					new Promise((done) => setTimeout(done, seconds * 1000)),
				]);
				return run.status === "running"
					? {
							status: "running",
							steps: run.steps,
							budget: run.budget,
							recentActions: run.recent,
							latestNote: run.note?.slice(0, 1500),
						}
					: { status: run.status, report: run.report };
			},
		}),
		message_sidekick: tool({
			description:
				"Send the sidekick feedback. While it works, the feedback reaches it at its next step; after it reports, it continues in its own context and reports back.",
			inputSchema: z.object({ feedback: z.string().min(1).max(4000) }),
			execute: async ({ feedback }) => {
				const run = current;
				if (run?.status === "running") {
					run.feedback.push(feedback);
					return { queued: true, deliveredAt: "the sidekick's next step" };
				}
				await runSidekick(
					run?.brief ?? feedback,
					{ role: "user", content: `Feedback from the lead:\n${feedback}` },
					run?.budget,
				);
				return { sent: true };
			},
		}),
		take_control: tool({
			description:
				"Take control back from the sidekick: stop it and continue the work yourself in the workspace.",
			inputSchema: z.object({ reason: z.string().min(1).max(500) }),
			execute: async ({ reason }) => {
				const run = current;
				if (run?.status === "running") {
					run.abort.abort(new Error(reason));
					await run.promise.catch(() => {});
				}
				return { status: "lead in control", sidekickReport: run?.report };
			},
		}),
	};

	try {
		return await runModelAgent(
			{
				...input.lead,
				// A full agent with a fixed tool set: every tool is offered from the start.
				toolSurface: "implementation",
				instructions: `${input.lead.instructions}\n${fusionLeadInstructions(config)}`,
				tools: { ...input.lead.tools, ...leadWorkspaceTools, ...fusionTools },
			},
			input.leadRuntime,
		);
	} finally {
		// A turn never leaves the sidekick running.
		if (current?.status === "running") {
			current.abort.abort(new Error("Lead turn ended"));
			await current.promise.catch(() => {});
		}
	}
}
