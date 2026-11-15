import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { parseRuntimeId } from "#/domain/agent-provider";
import { githubIssueFromUrl } from "#/domain/github-issues";
import { requireUser } from "#/server/auth/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Starts a new chat that works on this issue. The open chat is not continued. */
export const startIssueChatFn = createServerFn({ method: "POST" })
	.validator(
		(data: {
			projectId: string;
			harnessId: string;
			modelId?: string;
			requestId: string;
			number: number;
			title: string;
			url: string;
		}) => {
			if (!UUID.test(data.projectId) || !UUID.test(data.requestId))
				throw new Error("Issue not found.");
			const url = data.url.trim();
			const issue = githubIssueFromUrl(url);
			if (!issue || issue.number !== data.number)
				throw new Error("Issue not found.");
			const title = data.title.replace(/\s+/g, " ").trim().slice(0, 200);
			if (!title) throw new Error("Issue not found.");
			return {
				projectId: data.projectId,
				harnessId: parseRuntimeId(data.harnessId),
				modelId:
					typeof data.modelId === "string"
						? data.modelId.trim().slice(0, 300)
						: "",
				requestId: data.requestId,
				fullName: issue.fullName,
				number: issue.number,
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
			{ startIssueChat },
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
		const started = await startIssueChat(machines, {
			userId: user.id,
			...data,
		});
		return { projectId: data.projectId, sessionId: started.sessionId };
	});
