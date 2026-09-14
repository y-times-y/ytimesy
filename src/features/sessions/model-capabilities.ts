export interface ReasoningLevel {
	id: string;
	label: string;
}

export interface SessionModel {
	id: string;
	label: string;
	reasoning: {
		levels: readonly [ReasoningLevel, ...ReasoningLevel[]];
		defaultLevelId: string;
	} | null;
	supportsFastMode: boolean;
}

export function resolveReasoningLevel(
	model: SessionModel | undefined,
	requestedLevelId: string,
) {
	const capability = model?.reasoning;
	if (!capability) return undefined;
	return (
		capability.levels.find((level) => level.id === requestedLevelId) ??
		capability.levels.find((level) => level.id === capability.defaultLevelId) ??
		capability.levels[0]
	);
}

export function sessionModelsFromListed(
	models: readonly { readonly id: string; readonly label: string }[],
): SessionModel[] {
	return models.map((model) => ({
		id: model.id,
		label: model.label,
		reasoning: null,
		supportsFastMode: false,
	}));
}

export function preferredSessionModelId(
	models: readonly SessionModel[],
): string {
	const spark = models.find((model) => model.id === "gpt-5.3-codex-spark");
	return spark?.id ?? models[0]?.id ?? "";
}
