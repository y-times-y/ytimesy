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
