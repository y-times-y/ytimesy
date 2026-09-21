import {
	type ListedModelPreference,
	listedModelSupportsFastMode,
	preferredListedModelId,
} from "#/domain/listed-model";

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
		readonly supportsFastMode?: boolean;
		readonly fast?: boolean;
		readonly reasoning?: SessionModel["reasoning"];
	}[],
): SessionModel[] {
	return models.map((model) => ({
		id: model.id,
		label: model.label,
		notice: model.notice ?? null,
		reasoning: model.reasoning ?? null,
		supportsFastMode: listedModelSupportsFastMode(model),
	}));
}

export function preferredSessionModelId(
	models: readonly SessionModel[],
	options?: ListedModelPreference,
): string {
	return preferredListedModelId(models, options);
}
