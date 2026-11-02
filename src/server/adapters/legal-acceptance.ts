import {
	CURRENT_LEGAL_VERSIONS,
	type LegalAcceptance,
} from "#/domain/legal-acceptance";
import { database } from "./database";

export async function legalAcceptanceFor(
	userId: string,
): Promise<LegalAcceptance | null> {
	const row = (
		await database().query<{
			terms_version: string;
			privacy_version: string;
			accepted_at: Date;
		}>(
			"select terms_version,privacy_version,accepted_at from legal_acceptance where user_id=$1",
			[userId],
		)
	).rows[0];
	return row
		? {
				termsVersion: row.terms_version,
				privacyVersion: row.privacy_version,
				acceptedAt: new Date(row.accepted_at).toISOString(),
			}
		: null;
}

/**
 * Where acceptance was given: "signup" when an account is created and
 * "signin" when one signs in (both screens state that continuing accepts the
 * documents), "notice" when a signed-in user dismisses the "We updated our
 * Terms" notice. "prompt" is the retired blocking dialog, kept for old rows.
 */
export type LegalAcceptanceSource = "signup" | "signin" | "notice" | "prompt";

/** Records that the user accepted the current Terms and Privacy Policy now. */
export async function recordLegalAcceptance(
	userId: string,
	source: LegalAcceptanceSource,
) {
	await database().query(
		`insert into legal_acceptance(user_id,terms_version,privacy_version,source) values($1,$2,$3,$4)
		 on conflict(user_id) do update set terms_version=excluded.terms_version,privacy_version=excluded.privacy_version,
		 accepted_at=now(),source=excluded.source`,
		[
			userId,
			CURRENT_LEGAL_VERSIONS.termsVersion,
			CURRENT_LEGAL_VERSIONS.privacyVersion,
			source,
		],
	);
}

/**
 * Records acceptance at sign-in unless the current versions are already on
 * record, so the original sign-up row (and its source) stays when nothing
 * changed.
 */
export async function recordLegalAcceptanceAtSignIn(userId: string) {
	await database().query(
		`insert into legal_acceptance(user_id,terms_version,privacy_version,source) values($1,$2,$3,'signin')
		 on conflict(user_id) do update set terms_version=excluded.terms_version,privacy_version=excluded.privacy_version,
		 accepted_at=now(),source=excluded.source
		 where legal_acceptance.terms_version is distinct from excluded.terms_version
		    or legal_acceptance.privacy_version is distinct from excluded.privacy_version`,
		[
			userId,
			CURRENT_LEGAL_VERSIONS.termsVersion,
			CURRENT_LEGAL_VERSIONS.privacyVersion,
		],
	);
}
