import type { ListedContextWindow } from "#/domain/context-window-option";
import {
	type ListedModel,
	type ListedModelPreference,
	type ListedSpeed,
	listedModelSupportsFastMode,
	preferredListedModelId,
} from "#/domain/listed-model";
import { withoutRetiredModels } from "#/domain/retired-model";

export function composerListedModels({
	sessionModels,
	catalogModels,
	rememberedModels,
	sessionConnected,
	harnessId,
}: {
	sessionModels: readonly ListedModel[];
	catalogModels: readonly ListedModel[];
	rememberedModels: readonly ListedModel[];
	sessionConnected: boolean;
	/** The harness being shown: another harness's models never stand in for it. */
	harnessId?: string;
}): readonly ListedModel[] {
	if (sessionConnected && sessionModels.length) return sessionModels;
	if (catalogModels.length) return catalogModels;
	const own = (models: readonly ListedModel[]) =>
		harnessId
			? models.filter((model) => modelHarness(model.id) === harnessId)
			: models;
	const session = own(sessionModels);
	return session.length ? session : own(rememberedModels);
}

/** Which harness a composer model id belongs to: API and plan routes are "api". */
export function modelHarness(modelId: string): "api" | "codex" {
	return modelId.startsWith("api/") || modelId.startsWith("claude-code/")
		? "api"
		: "codex";
}

export interface ReasoningLevel {
	id: string;
	label: string;
}

export function reasoningLevelLabel(id: string): string {
	if (id === "xhigh") return "Extra high";
	return id
		.replace(/[_-]+/g, " ")
		.replace(/^./, (letter) => letter.toUpperCase());
}

export interface SessionModel {
	id: string;
	label: string;
	notice: string | null;
	reasoning: {
		levels: readonly [ReasoningLevel, ...ReasoningLevel[]];
		defaultLevelId: string;
	} | null;
	/** Faster speeds than standard; empty when the model has none. */
	speeds: readonly ListedSpeed[];
	/** A second context window the route offers; null when it has none. */
	contextWindow: ListedContextWindow | null;
	contextCapacity?: number;
}

/** The composer's speed choice; "" is standard speed. */
export type ComposerSpeed = "" | ListedSpeed["id"];

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
		readonly speeds?: readonly ListedSpeed[];
		readonly reasoning?: SessionModel["reasoning"];
		readonly contextWindow?: ListedContextWindow;
		readonly contextCapacity?: number;
	}[],
): SessionModel[] {
	// Retired models are never offered; a chat on one is shown by the composer.
	return withoutRetiredModels(models).map((model) => ({
		id: model.id,
		label: model.label,
		notice: model.notice ?? null,
		reasoning: model.reasoning ?? null,
		speeds:
			model.speeds ??
			(listedModelSupportsFastMode(model) ? [{ id: "fast" as const }] : []),
		contextWindow: model.contextWindow ?? null,
		...(model.contextCapacity
			? { contextCapacity: model.contextCapacity }
			: {}),
	}));
}

export function preferredSessionModelId(
	models: readonly SessionModel[],
	options?: ListedModelPreference,
): string {
	return preferredListedModelId(models, options);
}
