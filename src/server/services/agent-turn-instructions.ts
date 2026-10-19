import type { ToolSet } from "ai";
import {
	leanVisualQaInstructions,
	visualQaInstructions,
} from "#/domain/agent-desktop";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import { BUILDER_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import {
	LEAN_SHAPE_TOOLS,
	type LeanToolShape,
} from "#/domain/harness-model-profile";
import {
	codeModeInstructions,
	leanToolInstructions,
} from "#/domain/lean-tool-instructions";
import {
	BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS,
	PROJECT_KNOWLEDGE_INSTRUCTIONS,
} from "#/domain/project-knowledge";
import { projectSecretsInstructions } from "#/domain/project-secret";
import {
	AGENT_TOOL,
	type SubagentBudget,
	type SubagentRole,
} from "#/domain/subagent";
import {
	orchestratorInstructions,
	subagentRoleInstructions,
} from "#/domain/subagent-instructions";
import {
	type DeferredToolEntry,
	deferredToolsInstructions,
} from "./deferred-tools";
import { pluginSkillsInstructions } from "./plugin-skill-tools";

/** The system instructions of an API-harness turn, before the per-family tool profile. */
export function agentTurnInstructions(input: {
	session: {
		/** A subagent started through the agent tool (subagents=on). */
		readonly agentRole?: SubagentRole | null;
		readonly agentBudget?: SubagentBudget | null;
	};
	tools: ToolSet;
	plugins: Parameters<typeof pluginSkillsInstructions>[0];
	projectKnowledge: string | null;
	secretNames?: Parameters<typeof projectSecretsInstructions>[0];
	/** A lean builder surface (docs/builder-tool-surface.md): short instructions in its tools' names. */
	leanShape?: LeanToolShape;
	/** The repository's absolute path on the workspace (lean surfaces state it). */
	leanWorkingDirectory?: string;
	/** Tools loaded on demand (deferred-tools.ts), listed so the model knows they exist. */
	deferredTools?: readonly DeferredToolEntry[];
	/** Harness variant prEvidence=on: one line on `ytimesy-evidence`. */
	prEvidence?: boolean;
}) {
	if (input.leanShape)
		return leanTurnInstructions({ ...input, leanShape: input.leanShape });
	const { session, tools, plugins, projectKnowledge, secretNames } = input;
	return `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file with cat; read a matching skill's SKILL.md completely. ${BUILDER_ENVIRONMENT_INSTRUCTIONS} ${roleInstructions(session)}${"browser_screenshot" in tools ? ` ${visualQaInstructions()}` : ""}\n${pluginSkillsInstructions(plugins)}${secretNames?.length ? `\n${projectSecretsInstructions(secretNames)}` : ""}${projectKnowledge === null ? "" : `\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`}`;
}

/** The lean builder's whole system prompt before memory: who it is, its role, its tools and workspace commands. */
function leanTurnInstructions(
	input: Parameters<typeof agentTurnInstructions>[0] & {
		leanShape: LeanToolShape;
	},
) {
	return [
		`You are the ytimesy coding agent, working in this task's prepared repository checkout${input.leanWorkingDirectory ? ` at ${input.leanWorkingDirectory}` : ""}; commands start in the repository root and relative paths resolve there.${input.leanWorkingDirectory ? ` Tools that take absolute paths need paths under ${input.leanWorkingDirectory}.` : ""} Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file; read a matching skill's SKILL.md completely. ${roleInstructions(input.session)}`,
		leanToolInstructions(input.leanShape),
		CODE_MODE_TOOL in input.tools ? codeModeInstructions(input.leanShape) : "",
		deferredToolsInstructions(input.deferredTools ?? [], {
			codeMode: CODE_MODE_TOOL in input.tools,
		}),
		AGENT_TOOL in input.tools
			? orchestratorInstructions({ codeMode: CODE_MODE_TOOL in input.tools })
			: "",
		leanVisualQaInstructions(LEAN_SHAPE_TOOLS[input.leanShape], {
			prEvidence: input.prEvidence,
		}),
		pluginSkillsInstructions(input.plugins),
		input.secretNames?.length
			? projectSecretsInstructions(input.secretNames)
			: "",
		// The lean surfaces have no project-memory tools: the tool-free wording.
		input.projectKnowledge === null
			? ""
			: `${BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(input.projectKnowledge)}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** A subagent's own role and budget, else the root chat's role. */
function roleInstructions(
	session: Parameters<typeof agentTurnInstructions>[0]["session"],
) {
	return session.agentRole
		? subagentRoleInstructions(session.agentRole, session.agentBudget ?? null)
		: cloudAgentRoleInstructions();
}
