import type { ApiModelSpeedId } from "./api-model-list";

/** What an API-key turn asked for beyond its model; absent fields use the model's defaults. */
export type ApiTurnSettings = {
	readonly reasoning?: string;
	readonly speed?: ApiModelSpeedId;
	/** The route's larger context window (context-window-option.ts); absent is the standard one. */
	readonly largeContext?: true;
};

/** Stored settings, keeping only values a turn can use. */
export function apiTurnSettings(value: unknown): ApiTurnSettings {
	if (!value || typeof value !== "object") return {};
	const { reasoning, speed, largeContext } = value as Record<string, unknown>;
	return {
		...(typeof reasoning === "string" && reasoning ? { reasoning } : {}),
		...(speed === "fast" || speed === "ultrafast" ? { speed } : {}),
		...(largeContext === true ? { largeContext } : {}),
	};
}
