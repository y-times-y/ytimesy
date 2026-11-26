import { createContext, useContext } from "react";

/** Which canvas the Canvas view shows; no revision follows the latest. */
export type CanvasFocus = {
	readonly title: string;
	readonly revision?: number;
	/**
	 * An inline artifact expanded into the panel (src/domain/artifact.ts): the
	 * title is its panel title and this is the document to show. It is not a
	 * canvas the agent showed: one revision, and not kept.
	 */
	readonly document?: string;
};

/**
 * Opens a canvas in the right panel's Canvas view. The transcript provides
 * it from its onOpenCanvas; where there is none (a helper's or side chat's
 * transcript) a card shows without its Open action.
 */
export const CanvasOpenContext = createContext<
	((focus: CanvasFocus) => void) | null
>(null);

export function useCanvasOpener() {
	return useContext(CanvasOpenContext);
}
