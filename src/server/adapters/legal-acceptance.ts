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

/** Records that the user accepted the current Terms and Privacy Policy now. */
export async function recordLegalAcceptance(
	userId: string,
	source: "signup" | "prompt",
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
