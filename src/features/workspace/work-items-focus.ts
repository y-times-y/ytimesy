import { referenceKey } from "../sessions/agent-references";
import type { WorkItemsFocus, WorkItemsKind } from "./work-items-page";

/**
 * Where a pull request or issue chip opens in the app: the Pull requests or
 * Issues page, on that item, when its repository is connected to a project
 * (any pull request of it, open or not, and any issue). Null for any other
 * repository: the chip then opens GitHub.
 */
export function workItemsTarget(
	reference: {
		readonly kind: "pull-request" | "issue" | "number";
		readonly owner: string;
		readonly repo: string;
		readonly number: number;
	},
	connected: readonly {
		readonly fullName: string;
		readonly repositoryId: number;
	}[],
	at: number,
): { readonly page: WorkItemsKind; readonly focus: WorkItemsFocus } | null {
	const wanted = referenceKey({ ...reference, number: 0 });
	const repository = connected.find(
		(candidate) =>
			referenceKey({
				owner: candidate.fullName.split("/")[0] ?? "",
				repo: candidate.fullName.split("/")[1] ?? "",
				number: 0,
			}) === wanted,
	);
	if (!repository) return null;
	return {
		page: reference.kind === "issue" ? "issues" : "pull-requests",
		focus: {
			kind: reference.kind === "issue" ? "issue" : "pull-request",
			repositoryId: repository.repositoryId,
			number: reference.number,
			at,
		},
	};
}
