import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireUser } from "#/server/auth/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PullRequestFixPage = {
	signedIn: boolean;
	pull: {
		fullName: string;
		number: number;
		headRef: string;
		baseRef: string;
		url: string;
	} | null;
};

/** The "Fix with ytimesy" page's data: null unless the pull request is the signed-in user's. */
export const getPullRequestFixPage = createServerFn({ method: "GET" })
	.validator((data: { projectId: string; linkId: string }) => ({
		projectId: String(data.projectId),
		linkId: String(data.linkId),
	}))
	.handler(async ({ data }): Promise<PullRequestFixPage> => {
		let user: { id: string };
		try {
			user = await requireUser(getRequest().headers);
		} catch (error) {
			if (error instanceof Response && error.status === 401)
				return { signedIn: false, pull: null };
			throw error;
		}
		if (!UUID.test(data.projectId) || !UUID.test(data.linkId))
			return { signedIn: true, pull: null };
		const { pullRequestLinkForOwner } = await import(
			"#/server/adapters/pull-request-links"
		);
		const link = await pullRequestLinkForOwner(
			user.id,
			data.projectId,
			data.linkId,
		);
		return {
			signedIn: true,
			pull: link
				? {
						fullName: link.fullName,
						number: link.pullNumber,
						headRef: link.headRef,
						baseRef: link.baseRef,
						url: `https://github.com/${link.fullName}/pull/${link.pullNumber}`,
					}
				: null,
		};
	});

/** Starts (or continues) the pull request's chat on its branch; resolves the chat to open. */
export const startPullRequestFixChat = createServerFn({ method: "POST" })
	.validator(
		(data: {
			projectId: string;
			linkId: string;
			requestId: string;
			note?: string;
		}) => {
			if (
				!UUID.test(String(data.projectId)) ||
				!UUID.test(String(data.linkId)) ||
				!UUID.test(String(data.requestId))
			)
				throw new Error("Pull request not found.");
			return {
				projectId: data.projectId,
				linkId: data.linkId,
				requestId: data.requestId,
				note: typeof data.note === "string" ? data.note.slice(0, 6000) : "",
			};
		},
	)
	.handler(
		async ({ data }): Promise<{ projectId: string; sessionId: string }> => {
			const [
				{ requireSameOrigin },
				{ requireUserAction },
				{ Effect },
				{ FreestyleWorkspaceMachinesLive },
				{ WorkspaceMachineService },
				{ startPullRequestFix },
			] = await Promise.all([
				import("#/server/http"),
				import("#/server/adapters/user-action-rate"),
				import("effect"),
				import("#/server/adapters/freestyle/live"),
				import("#/server/services/capabilities"),
				import("#/server/services/pull-request-wake"),
			]);
			requireSameOrigin(getRequest());
			const user = await requireUser(getRequest().headers);
			await requireUserAction(user.id, "chat-send");
			const machines = await Effect.runPromise(
				Effect.provide(WorkspaceMachineService, FreestyleWorkspaceMachinesLive),
			);
			const started = await startPullRequestFix(machines, {
				userId: user.id,
				...data,
			});
			return { projectId: data.projectId, sessionId: started.sessionId };
		},
	);
