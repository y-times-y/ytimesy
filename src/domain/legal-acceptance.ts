import { PRIVACY_VERSION, TERMS_VERSION } from "#/content/legal/versions";

export type LegalAcceptance = {
	readonly termsVersion: string;
	readonly privacyVersion: string;
	readonly acceptedAt: string;
};

/** The current versions, as the acceptance a user gives today records them. */
export const CURRENT_LEGAL_VERSIONS = {
	termsVersion: TERMS_VERSION,
	privacyVersion: PRIVACY_VERSION,
} as const;

/** True when the user has accepted the current Terms and Privacy Policy. */
export function legalAcceptanceCurrent(
	accepted: Pick<LegalAcceptance, "termsVersion" | "privacyVersion"> | null,
	current: {
		termsVersion: string;
		privacyVersion: string;
	} = CURRENT_LEGAL_VERSIONS,
) {
	return (
		accepted?.termsVersion === current.termsVersion &&
		accepted.privacyVersion === current.privacyVersion
	);
}
