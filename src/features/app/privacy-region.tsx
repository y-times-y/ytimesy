import { createContext, type ReactNode, useContext } from "react";

type Region = { readonly strict: boolean; readonly analyticsOptIn: boolean };

/**
 * The visitor's privacy region, known from the server's page render (the
 * root loader), so nothing flips after hydration.
 */
const PrivacyRegion = createContext<Region>({
	strict: false,
	analyticsOptIn: false,
});

export function PrivacyRegionProvider(props: {
	readonly strict: boolean;
	/** Defaults to strict: every strict region also waits for analytics consent. */
	readonly analyticsOptIn?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<PrivacyRegion.Provider
			value={{
				strict: props.strict,
				analyticsOptIn: props.analyticsOptIn ?? props.strict,
			}}
		>
			{props.children}
		</PrivacyRegion.Provider>
	);
}

/** EU, EEA, UK or Switzerland (privacy-region.ts STRICT_PRIVACY_COUNTRIES). */
export function useStrictPrivacyRegion() {
	return useContext(PrivacyRegion).strict;
}

/** Analytics waits for consent here: no session replay, nothing kept in the browser. */
export function useAnalyticsOptInRegion() {
	return useContext(PrivacyRegion).analyticsOptIn;
}

/** "Help improve ytimesy" on the first-time cards: on, except in the EU/UK. */
export function useTrainingChoiceDefault() {
	return !useStrictPrivacyRegion();
}
