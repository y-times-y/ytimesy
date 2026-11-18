import { randomUUID } from "node:crypto";
import {
	codexSubscriptionRuntime,
	guardCodexInference,
} from "../adapters/codex-subscription-runtime";
import {
	type ApiModelAccess,
	type ModelAgentInput,
	runModelAgent,
} from "./api-agent-runtime";
import { runModelAgentStep } from "./model-agent-loop";
import { timed } from "./step-timing";

/**
 * The adapter (database, token vault) loads only when this process holds the
 * account's tokens: a turn runner box never does, so it is not a static
 * import (and the box's bundle does not load it).
 */
async function ownTokenRuntime(input: ModelAgentInput) {
	const { codexSubscriptionModel } = await import(
		"../adapters/codex-subscription"
	);
	return codexSubscriptionModel(
		input.userId,
		input.modelId,
		input.reasoning,
		input.fast,
		input.cacheScopeId,
		input.alternateContext === true,
	);
}

/**
 * A turn runner box's Codex runtime (docs/turn-runner-boxes.md,
 * "Subscription routes"): the catalog row, effort and cache key come from the
 * edge, and requests go to the edge's model proxy, which holds the account's
 * tokens and sends them to ChatGPT. Same model settings, same response
 * checks as the Durable Object's runtime; only the transport differs.
 */
export async function boxCodexRuntime(
	input: ModelAgentInput,
	access: ApiModelAccess,
) {
	if (!access.codexSelection)
		throw new Error(
			"This turn runner box cannot run Codex subscription turns.",
		);
	const selection = await access.codexSelection({
		modelId: input.modelId,
		reasoning: input.reasoning,
		fast: input.fast === true,
		alternateContext: input.alternateContext === true,
		cacheScopeId: input.cacheScopeId ?? randomUUID(),
	});
	const baseUrl = `${access.baseUrl.replace(/\/+$/, "")}/codex`;
	const transport: typeof fetch = async (url, init) => {
		if (String(url) !== `${baseUrl}/responses`)
			throw new Error("Unexpected subscription inference destination.");
		const headers = new Headers(init?.headers);
		// The pinned native ChatGPT transport derives cache affinity from this header.
		headers.set("session-id", selection.cacheKey);
		const response = await access.fetch(url, {
			...init,
			method: "POST",
			headers,
		});
		return guardCodexInference(url, response);
	};
	return codexSubscriptionRuntime({
		modelId: input.modelId,
		selection,
		fast: input.fast === true,
		alternateContext: input.alternateContext === true,
		baseUrl,
		// A placeholder the SDK needs to build a request; the edge's proxy
		// replaces the whole authorization.
		apiKey: access.apiKey,
		transport,
	});
}

type CodexRunInput = ModelAgentInput & { modelAccess?: ApiModelAccess };

/** Direct subscription transport shares the API harness loop and usage events; no native inference runner. */
export async function runCodexSubscriptionAgent(input: CodexRunInput) {
	const runtime = input.modelAccess
		? await boxCodexRuntime(input, input.modelAccess)
		: await ownTokenRuntime(input);
	return runModelAgent(input, runtime);
}

export async function runCodexSubscriptionAgentStep(input: CodexRunInput) {
	const runtime = await timed("model:runtime", () =>
		input.modelAccess
			? boxCodexRuntime(input, input.modelAccess)
			: ownTokenRuntime(input),
	);
	return runModelAgentStep(input, runtime);
}
