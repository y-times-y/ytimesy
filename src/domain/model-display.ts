/**
 * A model id as a person reads it: "claude-code/claude-sonnet-5-5" is
 * "Claude Sonnet 5.5", "gpt-6-luna" is "GPT 6 Luna". Route prefixes (the
 * Claude plan's "claude-code/", a key's "api/<connection>/") are dropped and
 * a provider-qualified id keeps only the model.
 */
const ACRONYMS = new Set(["gpt", "glm", "xai"]);

export function modelBaseId(modelId: string): string {
	const last = modelId.split("/").pop() ?? modelId;
	try {
		const decoded = decodeURIComponent(modelId);
		// A key's route is "api/<connection>/<provider>/<model>" once decoded.
		if (decoded.startsWith("api/")) return decoded.split("/").pop() ?? last;
	} catch {
		// Not percent-encoded: the last segment stands.
	}
	return last;
}

export function modelDisplayName(modelId: string): string {
	const tokens = modelBaseId(modelId)
		.split(/[-_\s]+/)
		.filter(Boolean);
	const words: string[] = [];
	for (const token of tokens) {
		const previous = words[words.length - 1];
		// "5-5" is one version, "5.5"; "4.7" already is.
		if (
			/^\d+$/.test(token) &&
			previous !== undefined &&
			/^\d+(\.\d+)*$/.test(previous)
		)
			words[words.length - 1] = `${previous}.${token}`;
		else words.push(token);
	}
	return words
		.map((word) =>
			ACRONYMS.has(word.toLowerCase())
				? word.toUpperCase()
				: word.charAt(0).toUpperCase() + word.slice(1),
		)
		.join(" ");
}
