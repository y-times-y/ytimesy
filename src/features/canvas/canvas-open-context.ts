import { createContext, useContext } from "react";

/** Which canvas the Canvas view shows; no revision follows the latest. */
export type CanvasFocus = {
	readonly title: string;
	readonly revision?: number;
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
