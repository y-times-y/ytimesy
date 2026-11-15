import { createContext, type ReactNode, useContext } from "react";
import {
	type ConsentTier,
	consentTier,
} from "#/features/analytics/consent-tier";

type Region = {
	readonly strict: boolean;
	readonly analyticsOptIn: boolean;
	readonly replayConsent: boolean;
};

/**
 * The visitor's privacy region, known from the server's page render (the
 * root loader), so nothing flips after hydration.
 */
const PrivacyRegion = createContext<Region>({
	strict: false,
	analyticsOptIn: false,
	replayConsent: false,
});

export function PrivacyRegionProvider(props: {
	readonly strict: boolean;
	/** Defaults to strict: every strict region also waits for analytics consent. */
	readonly analyticsOptIn?: boolean;
	/** Session replay waits for an Accept (California, Florida, Illinois). */
	readonly replayConsent?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<PrivacyRegion.Provider
			value={{
				strict: props.strict,
				analyticsOptIn: props.analyticsOptIn ?? props.strict,
				replayConsent: props.replayConsent ?? false,
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

/** Which consent rule applies here (consent-tier.ts). */
export function useConsentTier(): ConsentTier {
	const region = useContext(PrivacyRegion);
	return consentTier(region);
}

/** "Help improve ytimesy" on the first-time cards: on, except in the EU/UK. */
export function useTrainingChoiceDefault() {
	return !useStrictPrivacyRegion();
}
