/** What a turn says when the provider does not offer the chosen model to this account. */
export const MODEL_UNAVAILABLE_FAILURE =
	"This model isn't available from your provider. Pick another model.";

/**
 * A provider's own words for a model this account cannot use (for ChatGPT:
 * "The 'x' model is not supported when using Codex with a ChatGPT account").
 */
const MODEL_UNAVAILABLE_DETAIL =
	/\bmodel\b[^.]{0,80}\b(?:is not supported when using|does not exist|was not found|is not available|not found)\b|\bunknown model\b/i;

export function modelUnavailableDetail(detail: string): boolean {
	return MODEL_UNAVAILABLE_DETAIL.test(detail);
}

/** True for a turn's saved failure text that means the chosen model is not offered. */
export function isModelUnavailableFailureMessage(message: string): boolean {
	return message.startsWith(MODEL_UNAVAILABLE_FAILURE);
}
