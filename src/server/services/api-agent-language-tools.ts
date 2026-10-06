import { type ToolSet, tool } from "ai";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { runGuestCapability } from "./guest-node-capability";
import {
	LANGUAGE_INTELLIGENCE_SOURCE,
	languageQuery,
	languageQueryResult,
} from "./language-intelligence";

export function apiAgentLanguageTools(
	input: AgentToolWorkspaceInput & { signal: AbortSignal },
): ToolSet {
	return {
		inspect_code: tool({
			description:
				"Use a language server in the task VM for definitions, references, hover/type information, observed diagnostics, or a rename preview. Read-only: no edits are applied. Positions are 1-based UTF-16. TypeScript/JavaScript have pinned tooling; Python/Rust/Go require their language-server binary in the VM. Diagnostics are observations, not proof a full typecheck passed.",
			inputSchema: languageQuery,
			execute: async (args) => {
				const workspace = await resolveToolWorkspace(input);
				return runGuestCapability(
					workspace,
					"language",
					LANGUAGE_INTELLIGENCE_SOURCE,
					{ ...args, cwd: workspace.cwd },
					languageQueryResult,
					input.signal,
				);
			},
		}),
	};
}
