import { createContext, type ReactNode, useContext } from "react";

/**
 * Whether the visitor gets the EU/UK defaults, known from the server's page
 * render (the root loader), so nothing flips after hydration.
 */
const StrictPrivacyRegion = createContext(false);

export function PrivacyRegionProvider(props: {
	readonly strict: boolean;
	readonly children: ReactNode;
}) {
	return (
		<StrictPrivacyRegion.Provider value={props.strict}>
			{props.children}
		</StrictPrivacyRegion.Provider>
	);
}

export function useStrictPrivacyRegion() {
	return useContext(StrictPrivacyRegion);
}

/** "Help improve ytimesy" on the first-time cards: on, except in the EU/UK. */
export function useTrainingChoiceDefault() {
	return !useStrictPrivacyRegion();
}
