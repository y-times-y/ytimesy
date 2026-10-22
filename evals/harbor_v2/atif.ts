import { asSchema, type ToolSet } from "ai";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import {
	type ApiTokenUsage,
	addApiTokenUsage,
} from "../../src/domain/api-token-usage";
import { usageSince } from "../../src/domain/attempt-loop";
import {
	type ModelBilling,
	usageCostUsd,
} from "../../src/domain/model-pricing";

/**
 * ATIF (Agent Trajectory Interchange Format) for a Harbor trial, built from
 * the harness's own trace events. Harbor 0.24.0 (the version our runs pin)
 * validates trajectory.json in the agent's logs directory against
 * harbor/models/trajectories (schema_version ATIF-v1.0 .. v1.8) and derives
 * the trial's per-model usage from it; the public Codex Terminal-Bench jobs
 * publish ATIF-v1.7, which we match.
 *
 * Mapping (one agent step per model inference, as Harbor's own agents do):
 *   - step 1: system (the system prompt), step 2: user (the task),
 *   - each model response: an agent step with its text, reasoning, tool
 *     calls, the tool results as observations (source_call_id = the call),
 *     and metrics from that response's usage (the delta of the cumulative
 *     usage events), llm_call_count 1,
 *   - a native compaction: an agent step with extra.kind "compaction",
 *   - runtime notices the harness added (review findings): user steps.
 * Retracted partial output (a dropped stream sampled again) is removed.
 */
export const ATIF_SCHEMA_VERSION = "ATIF-v1.7";

export type TimedEvent = { at: string; event: ApiAgentEvent };
/** A user-role message the harness injected mid-run (e.g. review findings). */
export type TimedNotice = { at: string; afterEvent: number; text: string };

type ToolCall = {
	tool_call_id: string;
	function_name: string;
	arguments: Record<string, unknown>;
};
type ObservationResult = { source_call_id?: string; content?: string };
type Metrics = {
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_tokens?: number;
	cost_usd?: number;
	extra?: Record<string, unknown>;
};
export type AtifStep = {
	step_id: number;
	timestamp?: string;
	source: "system" | "user" | "agent";
	model_name?: string;
	reasoning_effort?: string;
	message: string;
	reasoning_content?: string;
	tool_calls?: ToolCall[];
	observation?: { results: ObservationResult[] };
	metrics?: Metrics;
	llm_call_count?: number;
	extra?: Record<string, unknown>;
};
export type AtifTrajectory = {
	schema_version: typeof ATIF_SCHEMA_VERSION;
	session_id: string;
	trajectory_id?: string;
	agent: {
		name: string;
		version: string;
		model_name?: string;
		tool_definitions?: Record<string, unknown>[];
		extra?: Record<string, unknown>;
	};
	steps: AtifStep[];
	notes?: string;
	final_metrics?: {
		total_prompt_tokens?: number;
		total_completion_tokens?: number;
		total_cached_tokens?: number;
		total_cost_usd?: number;
		total_steps?: number;
		extra?: Record<string, unknown>;
	};
	extra?: Record<string, unknown>;
	subagent_trajectories?: AtifTrajectory[];
};

const OUTPUT_LIMIT = 20_000;

function text(value: unknown) {
	const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
	return raw.length > OUTPUT_LIMIT
		? `${raw.slice(0, OUTPUT_LIMIT)}\n[... ${raw.length - OUTPUT_LIMIT} characters truncated in the trajectory]`
		: raw;
}

function argumentsOf(input: unknown): Record<string, unknown> {
	if (input && typeof input === "object" && !Array.isArray(input))
		return input as Record<string, unknown>;
	// Freeform tools (Codex's apply_patch) take a string.
	return { input: input ?? null };
}

/** One step's usage: the cumulative counters' difference (requests and long-context tier included). */
function usageDelta(
	previous: ApiTokenUsage | null,
	next: ApiTokenUsage,
): ApiTokenUsage {
	return usageSince(next, previous) ?? next;
}

function metricsOf(usage: ApiTokenUsage, billing: ModelBilling): Metrics {
	const cost = usageCostUsd(usage, billing);
	return {
		...(usage.inputTokens !== null ? { prompt_tokens: usage.inputTokens } : {}),
		...(usage.outputTokens !== null
			? { completion_tokens: usage.outputTokens }
			: {}),
		...(usage.cacheReadTokens !== null
			? { cached_tokens: usage.cacheReadTokens }
			: {}),
		...(cost !== null ? { cost_usd: Number(cost.toFixed(6)) } : {}),
		...(usage.cacheWriteTokens
			? { extra: { cache_write_tokens: usage.cacheWriteTokens } }
			: {}),
	};
}

type Draft = {
	timestamp: string;
	parts: { id: string; kind: "text" | "reasoning"; text: string }[];
	calls: ToolCall[];
	results: ObservationResult[];
	usage: ApiTokenUsage | null;
	compaction: boolean;
};

export function atifTrajectory(input: {
	sessionId: string;
	trajectoryId?: string;
	agent: { name: string; version: string; extra?: Record<string, unknown> };
	modelName: string;
	effort?: string;
	billing: ModelBilling;
	systemPrompt: string;
	instruction: string;
	startedAt: string;
	events: readonly TimedEvent[];
	/** Event indexes where a new model run began (its usage counters restart). */
	runStarts?: readonly number[];
	notices?: readonly TimedNotice[];
	toolDefinitions?: Record<string, unknown>[];
	notes?: string;
	extra?: Record<string, unknown>;
	/** Added to final_metrics.extra (the trial's AA-style cost block). */
	metricsExtra?: Record<string, unknown>;
	subagents?: AtifTrajectory[];
}): AtifTrajectory {
	const steps: AtifStep[] = [
		{
			step_id: 1,
			timestamp: input.startedAt,
			source: "system",
			message: input.systemPrompt,
		},
		{
			step_id: 2,
			timestamp: input.startedAt,
			source: "user",
			message: input.instruction,
		},
	];
	const drafts: (Draft | { notice: TimedNotice })[] = [];
	let current: Draft | null = null;
	// Whether the current draft's response has ended (its usage arrived).
	let closed = false;
	let compacting = false;
	let previousUsage: ApiTokenUsage | null = null;
	let total: ApiTokenUsage | null = null;
	const runStarts = new Set(input.runStarts ?? []);
	const callOwner = new Map<string, Draft>();
	const notices = [...(input.notices ?? [])].sort(
		(left, right) => left.afterEvent - right.afterEvent,
	);
	const open = (at: string) => {
		if (current && !closed) return current;
		current = {
			timestamp: at,
			parts: [],
			calls: [],
			results: [],
			usage: null,
			compaction: false,
		};
		closed = false;
		drafts.push(current);
		return current;
	};
	input.events.forEach(({ at, event }, index) => {
		if (index > 0 && runStarts.has(index)) {
			previousUsage = null;
			closed = true;
		}
		while (notices.length && notices[0].afterEvent < index) {
			const notice = notices.shift() as TimedNotice;
			drafts.push({ notice });
			closed = true;
		}
		switch (event.type) {
			case "text-delta":
			case "reasoning-delta": {
				const draft = open(at);
				const kind = event.type === "text-delta" ? "text" : "reasoning";
				const part = draft.parts.find(
					(entry) => entry.id === event.id && entry.kind === kind,
				);
				if (part) part.text += event.text;
				else draft.parts.push({ id: event.id, kind, text: event.text });
				break;
			}
			case "retract": {
				const ids = new Set(event.ids);
				for (const draft of drafts)
					if ("parts" in draft) {
						draft.parts = draft.parts.filter((part) => !ids.has(part.id));
						draft.calls = draft.calls.filter(
							(call) => !ids.has(call.tool_call_id),
						);
					}
				break;
			}
			case "tool-call": {
				const draft = open(at);
				draft.calls.push({
					tool_call_id: event.id,
					function_name: event.name,
					arguments: argumentsOf(event.input),
				});
				callOwner.set(event.id, draft);
				break;
			}
			case "tool-result": {
				const owner = callOwner.get(event.id);
				const result = {
					source_call_id: event.id,
					content: `${event.failed ? "[failed] " : ""}${text(event.output)}`,
				};
				if (owner) owner.results.push(result);
				break;
			}
			case "context":
				if (event.compacting) {
					compacting = true;
					closed = true;
				} else compacting = false;
				break;
			case "usage": {
				const delta = usageDelta(previousUsage, event.usage);
				previousUsage = event.usage;
				total = total ? addApiTokenUsage(total, delta) : delta;
				if (compacting || !current || closed) {
					// Usage with no open response: a compaction request.
					drafts.push({
						timestamp: at,
						parts: [],
						calls: [],
						results: [],
						usage: delta,
						compaction: true,
					});
					closed = true;
					break;
				}
				(current as Draft).usage = delta;
				closed = true;
				break;
			}
			default:
				break;
		}
	});
	for (const notice of notices) drafts.push({ notice });
	for (const draft of drafts) {
		const step_id = steps.length + 1;
		if ("notice" in draft) {
			steps.push({
				step_id,
				timestamp: draft.notice.at,
				source: "user",
				message: draft.notice.text,
				extra: { kind: "runtime-notice" },
			});
			continue;
		}
		if (
			!draft.compaction &&
			!draft.parts.length &&
			!draft.calls.length &&
			!draft.usage
		)
			continue;
		const message = draft.parts
			.filter((part) => part.kind === "text")
			.map((part) => part.text)
			.join("");
		const reasoning = draft.parts
			.filter((part) => part.kind === "reasoning")
			.map((part) => part.text)
			.join("\n");
		// Results must name a call of their own step (ATIF validates it).
		const callIds = new Set(draft.calls.map((call) => call.tool_call_id));
		const results = draft.results.filter(
			(result) => !result.source_call_id || callIds.has(result.source_call_id),
		);
		steps.push({
			step_id,
			timestamp: draft.timestamp,
			source: "agent",
			model_name: input.modelName,
			...(input.effort ? { reasoning_effort: input.effort } : {}),
			message: draft.compaction ? "[context compaction]" : message,
			...(reasoning ? { reasoning_content: reasoning } : {}),
			...(draft.calls.length ? { tool_calls: draft.calls } : {}),
			...(results.length ? { observation: { results } } : {}),
			...(draft.usage
				? { metrics: metricsOf(draft.usage, input.billing) }
				: {}),
			llm_call_count: 1,
			...(draft.compaction ? { extra: { kind: "compaction" } } : {}),
		});
	}
	// Assigned inside the forEach callback, which narrowing cannot see.
	const totals = total as ApiTokenUsage | null;
	const totalCost = totals ? usageCostUsd(totals, input.billing) : 0;
	const subagentCost = (input.subagents ?? []).reduce(
		(sum, sub) => sum + (sub.final_metrics?.total_cost_usd ?? 0),
		0,
	);
	return {
		schema_version: ATIF_SCHEMA_VERSION,
		session_id: input.sessionId,
		...(input.trajectoryId ? { trajectory_id: input.trajectoryId } : {}),
		agent: {
			name: input.agent.name,
			version: input.agent.version,
			model_name: input.modelName,
			...(input.toolDefinitions?.length
				? { tool_definitions: input.toolDefinitions }
				: {}),
			...(input.agent.extra ? { extra: input.agent.extra } : {}),
		},
		steps,
		...(input.notes ? { notes: input.notes } : {}),
		final_metrics: {
			...(totals?.inputTokens != null
				? { total_prompt_tokens: totals.inputTokens }
				: {}),
			...(totals?.outputTokens != null
				? { total_completion_tokens: totals.outputTokens }
				: {}),
			...(totals?.cacheReadTokens != null
				? { total_cached_tokens: totals.cacheReadTokens }
				: {}),
			...(totalCost !== null
				? {
						total_cost_usd: Number((totalCost + subagentCost).toFixed(6)),
					}
				: {}),
			total_steps: steps.length,
			...(input.billing.kind === "plan" || input.metricsExtra
				? {
						extra: {
							...(input.billing.kind === "plan"
								? { cost_basis: "list-price estimate; plan-billed route" }
								: {}),
							...input.metricsExtra,
						},
					}
				: {}),
		},
		...(input.extra ? { extra: input.extra } : {}),
		...(input.subagents?.length
			? { subagent_trajectories: input.subagents }
			: {}),
	};
}

/** Tool declarations in OpenAI's function-calling shape (ATIF's tool_definitions). */
export async function atifToolDefinitions(
	tools: ToolSet,
): Promise<Record<string, unknown>[]> {
	return Promise.all(
		Object.entries(tools).map(async ([name, definition]) => {
			let parameters: unknown;
			try {
				parameters = definition.inputSchema
					? await asSchema(definition.inputSchema).jsonSchema
					: undefined;
			} catch {
				parameters = undefined;
			}
			return {
				type: "function",
				function: {
					name,
					...(definition.description
						? { description: definition.description }
						: {}),
					...(parameters ? { parameters } : {}),
				},
			};
		}),
	);
}
