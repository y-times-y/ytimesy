export const INSPECTOR_SPLIT_MIN = 0.32;
export const INSPECTOR_SPLIT_MAX = 0.72;
export const INSPECTOR_SPLIT_DEFAULT = 0.66;
export const INSPECTOR_SPLIT_DESKTOP = 0.38;

export function inspectorStaysBesideChat(compact: boolean) {
	return !compact;
}

export function clampInspectorSplit(ratio: number): number {
	if (!Number.isFinite(ratio)) return INSPECTOR_SPLIT_DEFAULT;
	return Math.min(INSPECTOR_SPLIT_MAX, Math.max(INSPECTOR_SPLIT_MIN, ratio));
}

export function inspectorPaneIsWide(view: string): boolean {
	return view === "desktop" || view === "files";
}

export function inspectorSplitRatio(input: {
	readonly custom: number | null;
	readonly wide: boolean;
}): number {
	if (input.custom !== null) return clampInspectorSplit(input.custom);
	return input.wide ? INSPECTOR_SPLIT_DESKTOP : INSPECTOR_SPLIT_DEFAULT;
}

export function inspectorSplitFromPointer(input: {
	readonly clientX: number;
	readonly originX: number;
	readonly width: number;
}): number {
	if (input.width <= 0) return INSPECTOR_SPLIT_DEFAULT;
	return clampInspectorSplit((input.clientX - input.originX) / input.width);
}

export function nudgeInspectorSplit(ratio: number, direction: -1 | 1): number {
	return clampInspectorSplit(ratio + direction * 0.03);
}
