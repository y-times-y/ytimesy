import type { ToolSet } from "ai";
import { archiveModelContext } from "../../src/server/adapters/context-archives";
import { agentContextArchiveTools } from "../../src/server/services/agent-context-archive-tools";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import { automaticRepositoryContext } from "../../src/server/services/automatic-repository-context";
import type { ModelAgentInput } from "../../src/server/services/model-agent-loop";

/** Reuses production source freshness, scoped guidance, and recoverable context retirement. */
export function evaluationBuilderContext(input: {
	tools: ToolSet;
	workspace: AgentToolWorkspace;
	userId: string;
	sessionId: string;
	signal: AbortSignal;
	onEvent: ModelAgentInput["onEvent"];
}) {
	const context = automaticRepositoryContext({
		tools: {
			...input.tools,
			...agentContextArchiveTools(input),
		},
		workspace: async () => input.workspace,
		signal: input.signal,
		onEvent: input.onEvent,
	});
	return {
		tools: context.tools,
		prepareMessages: context.prepare,
		afterTools: context.afterTools,
		restoreInstructions: context.restoreInstructions,
		archiveHistory: (history: Parameters<typeof archiveModelContext>[2]) =>
			archiveModelContext(input.userId, input.sessionId, history),
	};
}
