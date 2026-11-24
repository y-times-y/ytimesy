import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	issueDetail,
	listIssues,
	referenceKind,
	runIssueAction,
} from "../../../server/adapters/github/issues";
import { repositoryChoices } from "../../../server/adapters/github/pull-request-actions";
import { endpoint, requireSameOrigin } from "../../../server/http";
import {
	githubRepositoryFor,
	repositorySelection,
} from "../../../server/services/github-repository-request";
import { issueWriteAction } from "../../../server/services/github-write-requests";
import { timed } from "../../../server/services/step-timing";

const listing = repositorySelection.extend({
	state: z.enum(["open", "closed", "all"]).default("open"),
});
const selection = repositorySelection.extend({
	number: z.coerce.number().int().positive().safe(),
});

/**
 * The repository's issues without leaving ytimesy: list, read, create, edit,
 * label, assign, comment, close and reopen, with the signed-in user's GitHub
 * token. GET without a number lists issues (`state`), with `choices=1` the
 * repository's labels and assignable people.
 */
export const Route = createFileRoute("/api/github/issue")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const search = Object.fromEntries(new URL(request.url).searchParams);
					const { token, fullName, refused } = await githubRepositoryFor(
						request,
						repositorySelection.parse(search),
						{ reuseAccess: true },
					);
					if (search.choices)
						return timed("github:choices", () =>
							repositoryChoices(token, fullName),
						).catch(refused);
					if (!search.number) {
						const { state } = listing.parse(search);
						return {
							issues: await timed("github:issues", () =>
								listIssues(token, fullName, state),
							).catch(refused),
						};
					}
					const { number } = selection.parse(search);
					if (search.kind)
						return timed("github:kind", () =>
							referenceKind(token, fullName, number),
						).catch(refused);
					return timed("github:issue", () =>
						issueDetail(token, fullName, number),
					).catch(refused);
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const raw = await request.json();
					const { token, fullName } = await githubRepositoryFor(
						request,
						repositorySelection.parse(raw),
						{ reuseAccess: false },
					);
					const number = await runIssueAction(
						token,
						fullName,
						issueWriteAction.parse(raw),
					);
					return issueDetail(token, fullName, number);
				}),
		},
	},
});
