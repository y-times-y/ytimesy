export interface ReasoningLevel {
	id: string;
	label: string;
}

export interface SessionModel {
	id: string;
	label: string;
	notice: string | null;
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
	models: readonly {
		readonly id: string;
		readonly label: string;
		readonly notice?: string;
	}[],
): SessionModel[] {
	return models.map((model) => ({
		id: model.id,
		label: model.label,
		notice: model.notice ?? null,
		reasoning: null,
		supportsFastMode: false,
	}));
}

export function preferredSessionModelId(
	models: readonly SessionModel[],
): string {
	return (
		listedModelId(models, isListedCodexSpark) ??
		listedModelId(models, isListedZenSpark13) ??
		listedModelId(models, isListedZenSpark) ??
		listedModelId(models, isListedZenFree) ??
		models[0]?.id ??
		""
	);
}

function listedModelId(
	models: readonly SessionModel[],
	listed: (id: string) => boolean,
): string | undefined {
	return models.find((model) => listed(model.id))?.id;
}

function isListedCodexSpark(id: string): boolean {
	return id === "gpt-5.3-codex-spark";
}

function isListedZenSpark13(id: string): boolean {
	return id.startsWith("opencode/") && id.includes("muse-spark-1.3");
}

function isListedZenSpark(id: string): boolean {
	return id.startsWith("opencode/") && id.includes("spark");
}

function isListedZenFree(id: string): boolean {
	return (
		id.startsWith("opencode/") &&
		(id.endsWith("-free") || id.includes("contributor-free"))
	);
}
