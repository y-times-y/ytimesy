import type { EvidenceRecord } from "#/domain/pr-evidence";
import { listSessionEvidence } from "#/server/adapters/pr-evidence-records";
import { pullRequestEvidenceEnabled } from "#/server/services/pr-evidence";

/** A chat's evidence cards; `enabled` says whether new captures can appear. */
export async function chatEvidence(
	userId: string,
	projectId: string,
	sessionId: string,
): Promise<{ enabled: boolean; evidence: EvidenceRecord[] }> {
	const [evidence, enabled] = await Promise.all([
		listSessionEvidence(userId, projectId, sessionId),
		pullRequestEvidenceEnabled(userId).catch(() => false),
	]);
	return { enabled, evidence };
}
