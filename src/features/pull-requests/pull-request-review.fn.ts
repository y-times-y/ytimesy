import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { parseRuntimeId } from "#/domain/agent-provider";
import { githubPullFullName } from "#/domain/pull-request-review";
import { requireUser } from "#/server/auth/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Starts a new chat that reviews this pull request. The open chat is not accepted. */
export const startPullRequestReviewChat = createServerFn({ method: "POST" })
	.validator(
		(data: {
			projectId: string;
			harnessId: string;
			modelId?: string;
			requestId: string;
			fullName: string;
			number: number;
			title: string;
			url: string;
		}) => {
			if (!UUID.test(data.projectId) || !UUID.test(data.requestId))
				throw new Error("Pull request not found.");
			const fullName = data.fullName.trim();
			const url = data.url.trim();
			const number = data.number;
			if (
				!FULL_NAME.test(fullName) ||
				!Number.isInteger(number) ||
				number < 1 ||
				githubPullFullName(url) !== fullName ||
				!url.endsWith(`/pull/${number}`)
			)
				throw new Error("Pull request not found.");
			const title = data.title.replace(/\s+/g, " ").trim().slice(0, 200);
			if (!title) throw new Error("Pull request not found.");
			return {
				projectId: data.projectId,
				harnessId: parseRuntimeId(data.harnessId),
				modelId:
					typeof data.modelId === "string"
						? data.modelId.trim().slice(0, 300)
						: "",
				requestId: data.requestId,
				fullName,
				number,
				title,
				url,
			};
		},
	)
	.handler(async ({ data }) => {
		const [
			{ requireSameOrigin },
			{ Effect },
			{ FreestyleWorkspaceMachinesLive },
			{ WorkspaceMachineService },
			{ startPullRequestReview },
		] = await Promise.all([
			import("#/server/http"),
			import("effect"),
			import("#/server/adapters/freestyle/live"),
			import("#/server/services/capabilities"),
			import("#/server/services/pull-request-review-chat"),
		]);
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const machines = await Effect.runPromise(
			Effect.provide(WorkspaceMachineService, FreestyleWorkspaceMachinesLive),
		);
		const started = await startPullRequestReview(machines, {
			userId: user.id,
			...data,
		});
		return { projectId: data.projectId, sessionId: started.sessionId };
	});
