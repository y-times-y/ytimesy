import { createHash } from "node:crypto";
import type { generateText } from "ai";
import type { ModelProvider } from "#/domain/model-connection";

export function apiPromptCacheSettings(input: {
	provider: ModelProvider;
	baseUrl: string;
	userId: string;
	connectionId: string;
	scopeId: string;
}): Pick<Parameters<typeof generateText>[0], "providerOptions" | "headers"> {
	const key = createHash("sha256")
		.update(JSON.stringify([input.userId, input.connectionId, input.scopeId]))
		.digest("hex");
	const host = new URL(input.baseUrl).hostname;
	if (input.provider === "anthropic" && host === "api.anthropic.com")
		return {
			providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
		};
	if (input.provider === "openai" && host === "api.openai.com")
		return { providerOptions: { openai: { promptCacheKey: key } } };
	if (input.provider === "openrouter" && host === "openrouter.ai")
		return { headers: { "x-session-id": key } };
	if (input.provider === "compatible") {
		if (host === "api.x.ai") return { headers: { "x-grok-conv-id": key } };
		if (host === "api.meta.ai")
			return { providerOptions: { openai: { promptCacheKey: key } } };
		if (host === "api.mistral.ai")
			return { providerOptions: { compatible: { prompt_cache_key: key } } };
	}
	return {};
}

const ALIBABA_CACHE_MODELS = new Set([
	"qwen/qwen3-max",
	"qwen/qwen-plus",
	"qwen/qwen3.6-plus",
	"qwen/qwen3-coder-plus",
	"qwen/qwen3-coder-flash",
]);

/** The generic SDK drops content-block provider metadata; amend only documented gateway routes. */
export function openRouterCacheFetch(
	fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		const body = JSON.parse(init.body);
		const model =
			typeof body.model === "string" ? body.model.replace(/:.*$/, "") : "";
		if (
			!(
				model.startsWith("anthropic/") ||
				model.startsWith("google/gemini-") ||
				ALIBABA_CACHE_MODELS.has(model)
			)
		)
			return fetch(url, init);
		if (!Array.isArray(body.messages)) return fetch(url, init);
		// Block markers preserve gateway endpoint choice; top-level Claude caching can restrict routing.
		const message = body.messages.findLast(
			(value: { role?: string; content?: unknown }) =>
				(value.role === "user" || value.role === "assistant") &&
				(typeof value.content === "string" || Array.isArray(value.content)),
		);
		if (!message) return fetch(url, init);
		const content =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		const lastText = content.findLastIndex(
			(part: { type?: string; text?: unknown }) =>
				part.type === "text" &&
				typeof part.text === "string" &&
				part.text.length > 0,
		);
		if (lastText < 0) return fetch(url, init);
		// Do not add another breakpoint when the caller has already configured caching.
		if (
			body.cache_control ||
			body.messages.some(
				(value: { content?: unknown }) =>
					Array.isArray(value.content) &&
					value.content.some((part) => part.cache_control),
			)
		)
			return fetch(url, init);
		message.content = content.map((part: unknown, index: number) =>
			index === lastText
				? { ...(part as object), cache_control: { type: "ephemeral" } }
				: part,
		);
		return fetch(url, { ...init, body: JSON.stringify(body) });
	};
}
