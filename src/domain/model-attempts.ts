export const maxParallelAgents = 5;

export type ModelAttemptSlot = {
	readonly modelId: string;
	readonly count: number;
};

export function modelAttemptTotal(slots: readonly ModelAttemptSlot[]) {
	return slots.reduce((total, slot) => total + slot.count, 0);
}

/** The composer names the first model and counts every additional run. */
export function modelAttemptSummary(label: string, total: number) {
	const name = label.trim();
	if (!name || total < 1) return "Select model";
	if (total === 1) return name;
	return `${name} + ${total - 1}`;
}

export function expandModelAttempts(slots: readonly ModelAttemptSlot[]) {
	return slots.flatMap((slot) =>
		Array.from({ length: slot.count }, () => slot.modelId),
	);
}

export function enableMultipleModelAttempts(
	modelId: string,
): ModelAttemptSlot[] {
	const id = modelId.trim();
	return id ? [{ modelId: id, count: 2 }] : [];
}

export function toggleModelAttempt(
	slots: readonly ModelAttemptSlot[],
	modelId: string,
): ModelAttemptSlot[] {
	const id = modelId.trim();
	if (!id) return [...slots];
	if (slots.some((slot) => slot.modelId === id)) {
		return slots.filter((slot) => slot.modelId !== id);
	}
	if (modelAttemptTotal(slots) >= maxParallelAgents) return [...slots];
	return [...slots, { modelId: id, count: 1 }];
}

export function setModelAttemptCount(
	slots: readonly ModelAttemptSlot[],
	modelId: string,
	count: number,
): ModelAttemptSlot[] {
	const others = modelAttemptTotal(
		slots.filter((slot) => slot.modelId !== modelId),
	);
	const next = Math.min(
		maxParallelAgents - others,
		Math.max(1, Math.floor(count)),
	);
	if (next < 1) return [...slots];
	return slots.map((slot) =>
		slot.modelId === modelId ? { ...slot, count: next } : slot,
	);
}

export function modelAttemptCountChoices(
	slots: readonly ModelAttemptSlot[],
	modelId: string,
) {
	const others = modelAttemptTotal(
		slots.filter((slot) => slot.modelId !== modelId),
	);
	const max = maxParallelAgents - others;
	return Array.from({ length: Math.max(0, max) }, (_, index) => index + 1);
}

export function modelIdForAttempt(
	attemptModelIds: readonly string[] | null | undefined,
	fallbackModelId: string,
	index: number,
) {
	return attemptModelIds?.[index - 1]?.trim() || fallbackModelId;
}

export function parallelAttemptModelIds(input: {
	readonly modelId: string;
	readonly modelIds?: readonly string[];
	readonly leaderCount: number;
}):
	| { readonly ok: true; readonly modelIds: string[] }
	| { readonly ok: false; readonly message: string } {
	const modelId = input.modelId.trim();
	const modelIds = input.modelIds?.length
		? input.modelIds.map((id) => id.trim())
		: Array.from({ length: input.leaderCount }, () => modelId);
	if (
		modelIds.length !== input.leaderCount ||
		modelIds.length < 2 ||
		modelIds.length > maxParallelAgents ||
		modelIds.some((id) => !id) ||
		modelIds[0] !== modelId
	) {
		return {
			ok: false,
			message: "Choose two to five model runs for this task.",
		};
	}
	return { ok: true, modelIds };
}
