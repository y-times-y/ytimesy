import { createHash } from "node:crypto";
import { type LanguageModel, type LanguageModelUsage, streamText } from "ai";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
import { parseModelRouteId } from "#/domain/model-connection";
import type { FailoverConnection } from "#/domain/model-failover";
import { modelBilling, usageCostUsd } from "#/domain/model-pricing";
import {
	type ResolvedChildModel,
	type RoleModels,
	resolveRoleModel,
} from "#/domain/role-models";
import {
	applicableDecision,
	CLASSIFIER_INSTRUCTIONS,
	type ClassifierAnswer,
	type ClassifierInput,
	classifierMessage,
	classifierTimeoutMs,
	DEFAULT_CLASSIFIER_MODEL,
	parseClassifierReply,
	rulesDecision,
	type SidekickDecisionRecord,
} from "#/domain/sidekick-classifier";
import { usageTokens } from "#/domain/subagent-usage";
import { apiTokenUsage } from "../adapters/api-token-usage";
import { reserveApiTokens } from "../adapters/api-usage-budget";
import { codexSubscriptionModel } from "../adapters/codex-subscription";
import { withApiModel } from "./api-agent-runtime";
import {
	type ModelAgentRuntime,
	withoutToolSettings,
} from "./model-agent-loop";
import { failoverConnections } from "./model-failover";

/** One classifier request: its text and usage. */
export type ClassifierCall = (input: {
	readonly userId: string;
	readonly model: ResolvedChildModel;
	readonly instructions: string;
	readonly message: string;
	readonly signal: AbortSignal;
}) => Promise<{ text: string; usage: LanguageModelUsage }>;

/** A failed classifier request, with the usage the provider reported before it failed. */
export class ClassifierCallError extends Error {
	constructor(
		readonly cause: unknown,
		readonly usage: LanguageModelUsage | undefined,
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = cause instanceof Error ? cause.name : "ClassifierCallError";
	}
}

export type SidekickClassifierDeps = {
	readonly routes?: (userId: string) => Promise<readonly FailoverConnection[]>;
	readonly call?: ClassifierCall;
	/** The API token budget (API routes only; a plan route is not metered per token). */
	readonly reserve?: typeof reserveApiTokens;
	readonly now?: () => number;
	readonly timeoutMs?: number;
};

/** A decision with what it cost to reach. */
export type SidekickClassification = {
	readonly answer: ClassifierAnswer;
	readonly record: SidekickDecisionRecord;
	/** The call's usage (also on a failure when the provider reported it); null without a call. */
	readonly usage: ApiTokenUsage | null;
};

const MAX_OUTPUT_TOKENS = 400;

async function streamOnce(
	model: LanguageModel,
	requestSettings: ModelAgentRuntime["requestSettings"],
	message: string,
	instructions: string,
	signal: AbortSignal,
) {
	const settings = withoutToolSettings(
		requestSettings?.(instructions) ?? { system: instructions },
	);
	const result = streamText({
		model,
		...settings,
		messages: [{ role: "user", content: message }],
		maxOutputTokens: MAX_OUTPUT_TOKENS,
		maxRetries: 0,
		abortSignal: signal,
		onError: () => {},
	});
	let reported: LanguageModelUsage | undefined;
	try {
		for await (const part of result.fullStream) {
			if (part.type === "finish-step") reported = part.usage;
			if (part.type === "error") throw part.error;
			if (part.type === "abort")
				throw signal.reason ?? new Error("The classifier was aborted.");
		}
		return { text: await result.text, usage: await result.totalUsage };
	} catch (cause) {
		throw new ClassifierCallError(cause, reported);
	}
}

/** The classifier request on the plan (codex:) or an API connection. */
export const callClassifierModel: ClassifierCall = async (input) => {
	if (input.model.harness === "codex") {
		const runtime = await codexSubscriptionModel(
			input.userId,
			input.model.listedModelId,
			input.model.reasoning,
		);
		return streamOnce(
			runtime.model,
			runtime.requestSettings,
			input.message,
			input.instructions,
			input.signal,
		);
	}
	const route = parseModelRouteId(input.model.listedModelId);
	if (!route) throw new Error("The classifier's route is not an API route.");
	return withApiModel(
		{
			userId: input.userId,
			connectionId: route.connectionId,
			modelId: route.modelId,
			reasoning: input.model.reasoning,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			signal: input.signal,
		},
		(runtime) =>
			streamOnce(
				runtime.model,
				runtime.requestSettings,
				input.message,
				input.instructions,
				input.signal,
			),
	);
};

/**
 * One decision about a sidekick round (or a compaction mid-round): the
 * classifier's answer on roleModels.classifier (codex:gpt-6-luna@low by
 * default), else the rules' when the call fails, times out, answers
 * anything but the JSON asked for, or the route is unavailable. Never throws.
 */
export async function classifySidekick(input: {
	readonly userId: string;
	/** The sidekick's session (its task's API token budget). */
	readonly sessionId: string;
	readonly roleModels: RoleModels | undefined;
	readonly summary: ClassifierInput;
	/** The turn's abort signal; the call also stops at its own short timeout. */
	readonly signal?: AbortSignal;
	readonly deps?: SidekickClassifierDeps;
}): Promise<SidekickClassification> {
	const deps = input.deps ?? {};
	const now = deps.now ?? Date.now;
	const started = now();
	const message = classifierMessage(input.summary);
	const inputsHash = createHash("sha256").update(message).digest("hex");
	const spec = input.roleModels?.classifier ?? DEFAULT_CLASSIFIER_MODEL;
	const { canSwitch, signals } = input.summary;
	let model: ResolvedChildModel | undefined;
	let usage: LanguageModelUsage | undefined;
	let answer: ClassifierAnswer | null = null;
	let fallback: string | undefined;
	try {
		const resolved = resolveRoleModel({
			role: "classifier",
			roleModels: {
				...input.roleModels,
				classifier: { ...spec, effort: spec.effort ?? "low" },
			},
			connections: await (deps.routes ?? failoverConnections)(input.userId),
			parentModel: "none",
		});
		if (resolved.kind !== "role")
			throw new Error(
				resolved.kind === "fallback" ? resolved.notice : "no classifier route",
			);
		model = resolved.model;
		if (model.harness !== "codex")
			await (deps.reserve ?? reserveApiTokens)(
				input.userId,
				input.sessionId,
				Buffer.byteLength(CLASSIFIER_INSTRUCTIONS + message, "utf8") +
					MAX_OUTPUT_TOKENS * 4,
			);
		const timeoutMs = deps.timeoutMs ?? classifierTimeoutMs();
		const reply = await (deps.call ?? callClassifierModel)({
			userId: input.userId,
			model,
			instructions: CLASSIFIER_INSTRUCTIONS,
			message,
			signal: input.signal
				? AbortSignal.any([AbortSignal.timeout(timeoutMs), input.signal])
				: AbortSignal.timeout(timeoutMs),
		});
		usage = reply.usage;
		answer = parseClassifierReply(reply.text);
		if (!answer)
			fallback = `unparsable reply: ${reply.text.trim().slice(0, 120) || "(empty)"}`;
	} catch (cause) {
		if (cause instanceof ClassifierCallError) usage = cause.usage;
		const error = cause instanceof Error ? cause : new Error(String(cause));
		fallback = input.signal?.aborted
			? "the turn was stopped"
			: error.name === "TimeoutError" || error.name === "AbortError"
				? "timed out"
				: `failed: ${error.message.slice(0, 160)}`;
	}
	const decided = answer
		? applicableDecision(answer, canSwitch)
		: rulesDecision(signals, canSwitch);
	const counts = usage ? apiTokenUsage(usage) : null;
	const billing = modelBilling({
		harness: model?.harness === "codex" ? "codex" : "api",
		modelId: model?.listedModelId ?? null,
	});
	const record: SidekickDecisionRecord = {
		point: input.summary.point,
		round: input.summary.round,
		decision: decided.decision,
		reason: decided.reason,
		source: answer ? "classifier" : "rules",
		...(fallback ? { fallback } : {}),
		inputsHash,
		latencyMs: Math.max(0, now() - started),
		tokens: usageTokens(counts),
		costUsd: counts ? usageCostUsd(counts, billing) : 0,
		planBilled: billing.kind === "plan",
		...(model ? { model: model.listedModelId } : {}),
		at: new Date(now()).toISOString(),
	};
	return { answer: decided, record, usage: counts };
}
