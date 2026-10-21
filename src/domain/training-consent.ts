/**
 * Training-data consent (src/content/legal/training-opt-in.md). Off unless
 * the user turns it on; a project can only exclude itself, never opt in.
 */
export type TrainingConsent = {
	readonly enabled: boolean;
	/** Training policy version shown when the setting last changed; null if never set. */
	readonly policyVersion: string | null;
	readonly changedAt: string | null;
};

export const TRAINING_CONSENT_OFF: TrainingConsent = {
	enabled: false,
	policyVersion: null,
	changedAt: null,
};

/** A turn may ever be used for training only if both hold when it starts. */
export function turnTrainingEligible(input: {
	readonly consentEnabled: boolean;
	readonly projectExcluded: boolean;
}) {
	return input.consentEnabled && !input.projectExcluded;
}
