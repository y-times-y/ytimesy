export type ListedModel = {
	readonly id: string;
	readonly label: string;
	readonly notice?: string;
};

export function preferredListedModelId(
	models: readonly { readonly id: string }[],
): string {
	return (
		models.find((model) => model.id === "gpt-5.3-codex-spark")?.id ??
		models.find(
			(model) =>
				model.id.startsWith("opencode/") && model.id.includes("muse-spark-1.3"),
		)?.id ??
		models.find(
			(model) => model.id.startsWith("opencode/") && model.id.includes("spark"),
		)?.id ??
		models.find(
			(model) =>
				model.id.startsWith("opencode/") &&
				(model.id.endsWith("-free") || model.id.includes("contributor-free")),
		)?.id ??
		models[0]?.id ??
		""
	);
}

export function submittedListedModelId(
	requested: string,
	models: readonly { readonly id: string }[],
): string {
	const trimmed = requested.trim();
	if (trimmed && models.some((model) => model.id === trimmed)) return trimmed;
	return preferredListedModelId(models);
}
