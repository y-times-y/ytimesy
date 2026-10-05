import { redactSecrets } from "#/domain/project-workspace";

export function redactEvaluationText(text: string) {
	return redactSecrets(text)
		.replace(/\bsk-[\w-]{12,}/g, "[redacted]")
		.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]");
}
