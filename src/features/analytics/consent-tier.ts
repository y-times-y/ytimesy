/**
 * How much of analytics waits for the visitor's Accept, by where they are
 * (the server reads it from Cloudflare, privacy-region.ts):
 *
 * - "analytics": EU, EEA, UK, Switzerland, Turkey, South Korea, Quebec.
 *   Nothing is recorded, sent or stored until Accept.
 * - "replay": California, Florida, Illinois. Analytics runs; session replay
 *   waits for Accept.
 * - "notice": everywhere else. Replay is on, with a first-visit notice and a
 *   way to turn it off.
 */
export type ConsentTier = "analytics" | "replay" | "notice";

export function consentTier(region: {
	readonly analyticsOptIn: boolean;
	readonly replayConsent: boolean;
}): ConsentTier {
	if (region.analyticsOptIn) return "analytics";
	return region.replayConsent ? "replay" : "notice";
}
