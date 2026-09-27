import { queryOptions } from "@tanstack/react-query";
import type { AgentProviderId } from "#/domain/agent-provider";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { getCodexSession } from "./codex-session.fn";

export type SessionReadSelection = {
	projectId: string;
	sessionId: string;
	harnessId: AgentProviderId;
};

export function sessionReconciliationQuery(
	selection: SessionReadSelection,
	epoch: number,
	read: (selection: SessionReadSelection) => Promise<PublicCodexSession> = (
		data,
	) => getCodexSession({ data }),
) {
	return queryOptions({
		queryKey: [
			"session-reconciliation",
			selection.projectId,
			selection.sessionId,
			selection.harnessId,
			epoch,
		],
		queryFn: async ({ signal }) => {
			const view = await read(selection);
			signal.throwIfAborted();
			return { epoch, view };
		},
		retry: false,
		refetchOnWindowFocus: false,
	});
}
