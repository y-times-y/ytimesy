/**
 * Models retired from the pickers on 2026-11-17: every GPT-5 variant (gpt-5,
 * gpt-5.x, -codex, mini, nano, bare or `openai/`-prefixed) and Claude Fable
 * 5.1. Retired models are no longer OFFERED, but chats that used them keep
 * resolving pricing, context windows and failover equivalence, and the server
 * still accepts their ids; so only list builders use this predicate.
 */
const RETIRED_GPT_5 = /(?:^|[/\s:])gpt[- ]?5(?:[.\-\s:]|$)/i;
const RETIRED_FABLE_5_1 = /fable[- ]5[-.]1(?!\d)/i;

/** True for a model id or display label that is retired (see above). */
export function isRetiredModel(idOrLabel: string | null | undefined) {
	if (!idOrLabel) return false;
	// Route ids carry the model id URL-encoded ("api/<connection>/openai%2Fgpt-5").
	let text = idOrLabel;
	try {
		text = decodeURIComponent(idOrLabel);
	} catch {}
	return RETIRED_GPT_5.test(text) || RETIRED_FABLE_5_1.test(text);
}

/**
 * Whether the composer keeps sending on `current` though no picker lists it:
 * only the chat's own retired model, until the person picks another.
 */
export function keepsRetiredChatModel(
	current: string,
	chatModelId: string | null | undefined,
) {
	return Boolean(current) && current === chatModelId && isRetiredModel(current);
}

/** The entries a picker may offer: retired ones (by id or label) left out. */
export function withoutRetiredModels<
	T extends { readonly id: string; readonly label?: string },
>(models: readonly T[]): T[] {
	return models.filter(
		(model) => !isRetiredModel(model.id) && !isRetiredModel(model.label),
	);
}
