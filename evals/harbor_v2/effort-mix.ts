import type { LanguageModel } from "ai";
import { leadReasoningEffort } from "../../src/domain/harness-variant";
import {
	providerOptionsEffort,
	withProviderOptionsEffort,
} from "../../src/server/adapters/api-reasoning-effort";

/**
 * The reasoning sandwich (harness variant effortMix=on, unattended runs):
 * the root builder plans at the turn's effort (its first
 * EFFORT_MIX_PLANNING_REQUESTS model requests), executes at
 * EFFORT_MIX_EXECUTION, and works every continuation round the harness sends
 * (the grind notice; any later gate the same way) at the turn's effort again.
 * A request is only ever lowered, never raised: a turn at high or lower, or a
 * request at a lower effort of its own (a context summary at low), is sent
 * unchanged. The effort travels in each request's provider options, so every
 * route that sends one (OpenAI Responses, the Codex subscription, Anthropic
 * Messages, both Bedrock routes, OpenRouter) is covered; a route without one
 * (Gemini) keeps its provider default.
 */

/** Model requests at the turn's effort before execution begins. */
export const EFFORT_MIX_PLANNING_REQUESTS = 2;

/** The effort execution requests are held at. */
export const EFFORT_MIX_EXECUTION = "high";

type CallOptions = {
	providerOptions?: Record<string, Record<string, unknown>>;
};

/**
 * The root builder's request effort schedule. `wrap` returns the model with
 * each doStream/doGenerate call's effort set for its place in the trial and
 * logged (`effort <n> <level>`, `default` when the request names none).
 */
export function effortMix(log: (line: string) => void) {
	let requests = 0;
	let continuation = false;
	return {
		/** Continuation rounds use the turn's effort from here on. */
		continuation() {
			continuation = true;
		},
		wrap(model: LanguageModel): LanguageModel {
			if (typeof model === "string")
				throw new Error("Expected a concrete model transport.");
			return new Proxy(model, {
				get(target, property, receiver) {
					const value = Reflect.get(target, property, receiver);
					if (property === "doStream" || property === "doGenerate")
						return (options: CallOptions, ...rest: unknown[]) => {
							requests++;
							const turn = providerOptionsEffort(options.providerOptions);
							const effort =
								continuation || requests <= EFFORT_MIX_PLANNING_REQUESTS
									? turn
									: leadReasoningEffort(turn, EFFORT_MIX_EXECUTION);
							log(`effort ${requests} ${effort ?? "default"}`);
							const call =
								effort && effort !== turn && options.providerOptions
									? {
											...options,
											providerOptions: withProviderOptionsEffort(
												options.providerOptions,
												effort,
											),
										}
									: options;
							return (value as (...args: unknown[]) => unknown).apply(target, [
								call,
								...rest,
							]);
						};
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
}
