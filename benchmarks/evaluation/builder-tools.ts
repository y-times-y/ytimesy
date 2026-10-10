import type { ToolSet } from "ai";
import { agentOutputArtifacts } from "../../src/server/services/agent-output-artifacts";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import { apiAgentCommandTools } from "../../src/server/services/api-agent-command-tools";
import { apiAgentFileTools } from "../../src/server/services/api-agent-file-tools";
import { apiAgentImageTools } from "../../src/server/services/api-agent-image-tools";
import { apiAgentLanguageTools } from "../../src/server/services/api-agent-language-tools";
import { apiAgentSearchTools } from "../../src/server/services/api-agent-search-tools";
import { batchedAgentReads } from "../../src/server/services/batched-agent-reads";
import { codeToolingTools } from "../../src/server/services/code-tooling";
import { dapDebuggerTools } from "../../src/server/services/dap-debugger";
import { nodeDebuggerTools } from "../../src/server/services/node-debugger";
import { repositoryGuidanceTool } from "../../src/server/services/repository-guidance";

/** Reuses actual editing/search/check tools, with no leader, delegation, or publication capability. */
export function evaluationBuilderTools(
	workspace: AgentToolWorkspace & {
		signal: AbortSignal;
		sessionId: string;
		turnId: string;
	},
	options: { nativePatch?: boolean } = {},
): ToolSet {
	const receipts = new Map<string, Promise<unknown>>();
	const execution = {
		...workspace,
		ownerSessionId: workspace.sessionId,
		readOnly: false,
		once: (id: string, run: () => Promise<unknown>) => {
			let receipt = receipts.get(id);
			if (!receipt) {
				receipt = run();
				receipts.set(id, receipt);
			}
			return receipt;
		},
	};
	const output = agentOutputArtifacts(execution);
	const tools: ToolSet = {
		...apiAgentFileTools({
			...execution,
			output,
			nativePatch: options.nativePatch ?? false,
		}),
		...apiAgentSearchTools({ ...execution, output }),
		...apiAgentLanguageTools(execution),
		...apiAgentImageTools(execution),
		...apiAgentCommandTools({ ...execution, output }),
		...nodeDebuggerTools(execution),
		...dapDebuggerTools(execution),
		...codeToolingTools(execution),
		read_tool_output: output.readTool,
		read_repository_guidance: repositoryGuidanceTool(execution),
	};
	tools.batch_read = batchedAgentReads(tools, workspace.signal);
	return tools;
}
