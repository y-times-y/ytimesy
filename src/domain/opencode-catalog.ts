import {
	type ListedModel,
	listedModelSupportsFastMode,
} from "./listed-model";

export function parseOpenCodeModelCatalog(
	payload: unknown,
): readonly ListedModel[] {
	if (payload == null) return [];
	if (typeof payload === "string") {
		try {
			return parseOpenCodeModelCatalog(JSON.parse(payload));
		} catch {
			return [];
		}
	}
	const models: ListedModel[] = [];
	const seen = new Set<string>();
	for (const model of collectCatalogModels(payload)) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

function collectCatalogModels(payload: unknown): ListedModel[] {
	if (Array.isArray(payload)) {
		return payload.flatMap((row) => modelsFromUnknown(row, null));
	}
	if (!isRecord(payload)) return [];
	if (Array.isArray(payload.data)) {
		return payload.data.flatMap((row) => modelsFromUnknown(row, null));
	}
	if (Array.isArray(payload.models)) {
		return payload.models.flatMap((row) => modelsFromUnknown(row, null));
	}
	const providers = Array.isArray(payload.providers)
		? payload.providers
		: Array.isArray(payload.all)
			? payload.all
			: [];
	const models: ListedModel[] = [];
	for (const provider of providers) {
		if (!isRecord(provider)) continue;
		const providerId = readString(provider.id);
		if (Array.isArray(provider.models)) {
			models.push(
				...provider.models.flatMap((row) => modelsFromUnknown(row, providerId)),
			);
			continue;
		}
		if (isRecord(provider.models)) {
			for (const [key, row] of Object.entries(provider.models)) {
				models.push(...modelsFromUnknown(row, providerId, key));
			}
		}
	}
	return models;
}

function modelsFromUnknown(
	value: unknown,
	providerId: string | null | undefined,
	fallbackId?: string,
): ListedModel[] {
	if (typeof value === "string" && value.trim()) {
		const id = qualifyModelId(providerId, value.trim());
		return [{ id, label: value.trim() }];
	}
	if (!isRecord(value) && !fallbackId) return [];
	const record = isRecord(value) ? value : {};
	const modelId =
		readString(record.id) ??
		readString(record.modelID) ??
		readString(record.modelId) ??
		fallbackId;
	if (!modelId) return [];
	const listedProvider =
		readString(record.providerID) ??
		readString(record.providerId) ??
		providerId;
	const id = qualifyModelId(listedProvider, modelId);
	const label = readString(record.name) ?? readString(record.label) ?? modelId;
	const notice = noticeFromModel(record);
	const supportsFastMode = listedModelSupportsFastMode(record);
	return [
		{
			id,
			label,
			...(notice ? { notice } : {}),
			...(supportsFastMode ? { supportsFastMode } : {}),
		},
	];
}

export function noticeFromModel(
	model: Record<string, unknown>,
): string | undefined {
	const parts = [
		readString(model.notice),
		readString(model.warning),
		readString(model.privacy),
		readString(model.limitNotice),
		trainingNotice(model),
		freeTimeLimitNotice(model),
	].filter((part): part is string => Boolean(part));
	if (parts.length === 0) return undefined;
	return uniqueStrings(parts).join(" ");
}

function trainingNotice(model: Record<string, unknown>): string | undefined {
	const training =
		model.training === true ||
		model.usesPromptsForTraining === true ||
		(isRecord(model.privacyPolicy) && model.privacyPolicy.training === true);
	if (!training) return undefined;
	return (
		readString(model.trainingNotice) ??
		"This provider may use prompts for training."
	);
}

function freeTimeLimitNotice(
	model: Record<string, unknown>,
): string | undefined {
	const timeLimited =
		model.timeLimited === true ||
		readString(model.availability) === "limited" ||
		(typeof model.freeUntil === "string" && model.freeUntil.length > 0);
	if (!timeLimited) return undefined;
	return (
		readString(model.timeLimitNotice) ?? "This free model is time-limited."
	);
}

function qualifyModelId(
	providerId: string | null | undefined,
	modelId: string,
) {
	if (!providerId || modelId.includes("/")) return modelId;
	return `${providerId}/${modelId}`;
}

function uniqueStrings(values: readonly string[]) {
	return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}
