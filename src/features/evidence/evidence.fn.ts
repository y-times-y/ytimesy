import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { EvidenceContext, EvidenceRecord } from "#/domain/pr-evidence";
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
		}): Promise<{
			signedIn: boolean;
			evidence: EvidenceRecord | null;
			/** For an agent capture: every agent capture of its chat, newest first. */
			captures?: EvidenceRecord[];
			/** Its chat and pull request, for the page's header. */
			context?: EvidenceContext;
			/** The server's clock, so the first paint's "2 h ago" matches hydration. */
			now?: string;
		}> => {
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
			const { evidenceContextForOwner, evidenceForOwner, listAgentCaptures } =
				await import("#/server/adapters/pr-evidence-records");
			const evidence = await evidenceForOwner(
				user.id,
				data.projectId,
				data.evidenceId,
			);
			// A pull request links its chat's newest agent capture; the page shows them all.
			if (!evidence) return { signedIn: true, evidence };
			const [captures, context] = await Promise.all([
				evidence.source === "agent" && evidence.sessionId
					? listAgentCaptures(user.id, data.projectId, evidence.sessionId, 60)
					: undefined,
				evidenceContextForOwner(user.id, evidence),
			]);
			return {
				signedIn: true,
				evidence,
				...(captures ? { captures } : {}),
				context,
				now: new Date().toISOString(),
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
