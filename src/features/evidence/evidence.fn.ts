import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import { requireUser } from "#/server/auth/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(value: unknown) {
	if (typeof value !== "string" || !UUID.test(value))
		throw new Response("Not found.", { status: 404 });
	return value;
}

/** The evidence page's data: null when the capture is not the signed-in user's. */
export const getEvidencePage = createServerFn({ method: "GET" })
	.validator((data: { projectId: string; evidenceId: string }) => ({
		projectId: data.projectId,
		evidenceId: data.evidenceId,
	}))
	.handler(
		async ({
			data,
		}): Promise<{ signedIn: boolean; evidence: EvidenceRecord | null }> => {
			let user: { id: string };
			try {
				user = await requireUser(getRequest().headers);
			} catch (error) {
				if (error instanceof Response && error.status === 401)
					return { signedIn: false, evidence: null };
				throw error;
			}
			if (!UUID.test(data.projectId) || !UUID.test(data.evidenceId))
				return { signedIn: true, evidence: null };
			const { evidenceForOwner } = await import(
				"#/server/adapters/pr-evidence-records"
			);
			return {
				signedIn: true,
				evidence: await evidenceForOwner(
					user.id,
					data.projectId,
					data.evidenceId,
				),
			};
		},
	);

/** A chat's evidence cards; `enabled` says whether new captures can appear. */
export const listChatEvidence = createServerFn({ method: "GET" })
	.validator((data: { projectId: string; sessionId: string }) => ({
		projectId: uuid(data.projectId),
		sessionId: uuid(data.sessionId),
	}))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const { chatEvidence } = await import("#/server/services/chat-evidence");
		return chatEvidence(user.id, data.projectId, data.sessionId);
	});
