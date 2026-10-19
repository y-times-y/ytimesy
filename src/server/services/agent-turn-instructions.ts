import type { ToolSet } from "ai";
import {
	leanVisualQaInstructions,
	visualQaInstructions,
} from "#/domain/agent-desktop";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import {
	BUILDER_ENVIRONMENT_INSTRUCTIONS,
	PREPARED_ENVIRONMENT_INSTRUCTIONS,
} from "#/domain/environment-context";
import {
	LEAN_SHAPE_TOOLS,
	type LeanToolShape,
} from "#/domain/harness-model-profile";
import {
	codeModeInstructions,
	leanToolInstructions,
	primaryCodeModeInstructions,
} from "#/domain/lean-tool-instructions";
import {
	BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS,
	PROJECT_KNOWLEDGE_INSTRUCTIONS,
} from "#/domain/project-knowledge";
import { projectSecretsInstructions } from "#/domain/project-secret";
import {
	AGENT_TOOL,
	isReaderRole,
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
	shellBuilder: boolean;
	session: Parameters<typeof cloudAgentRoleInstructions>[0] & {
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
	/** A read-only subagent's lean surface: commands and reads, no file-changing tools. */
	leanReadOnly?: boolean;
	/** The repository's absolute path on the workspace (lean surfaces state it). */
	leanWorkingDirectory?: string;
	/** Tools loaded on demand (deferred-tools.ts), listed so the model knows they exist. */
	deferredTools?: readonly DeferredToolEntry[];
	/** Harness variant codeMode (with run_code in the tools): primary teaches run_code as the main tool. */
	codeMode?: "on" | "primary";
	/** Harness variant prEvidence=on: one line on `ytimesy-evidence`. */
	prEvidence?: boolean;
}) {
	if (input.leanShape)
		return leanTurnInstructions({ ...input, leanShape: input.leanShape });
	const {
		shellBuilder,
		session,
		tools,
		plugins,
		projectKnowledge,
		secretNames,
	} = input;
	return `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository.${shellBuilder ? " Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file with cat; read a matching skill's SKILL.md completely." : " Call read_repository_guidance before implementation and for nested paths; read applicable instructions and skill bodies completely. Search optional tools with search_tools."} ${shellBuilder ? BUILDER_ENVIRONMENT_INSTRUCTIONS : `${PREPARED_ENVIRONMENT_INSTRUCTIONS} Use read_environment_report for that setup report; do not pass its /tmp path to repository file readers.`} ${roleInstructions(session, shellBuilder, AGENT_TOOL in tools)}${shellBuilder && "browser_screenshot" in tools ? ` ${visualQaInstructions()}` : ""}\n${pluginSkillsInstructions(plugins)}${secretNames?.length ? `\n${projectSecretsInstructions(secretNames)}` : ""}${projectKnowledge === null ? "" : `\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`}`;
}

/** The lean builder's whole system prompt before memory: who it is, its role, its tools and workspace commands. */
function leanTurnInstructions(
	input: Parameters<typeof agentTurnInstructions>[0] & {
		leanShape: LeanToolShape;
	},
) {
	const codeMode =
		CODE_MODE_TOOL in input.tools
			? input.codeMode === "primary"
				? "primary"
				: true
			: false;
	const readOnly = !!input.leanReadOnly;
	return [
		`You are the ytimesy coding agent, working in this task's prepared repository checkout${input.leanWorkingDirectory ? ` at ${input.leanWorkingDirectory}` : ""}; commands start in the repository root and relative paths resolve there.${input.leanWorkingDirectory ? ` Tools that take absolute paths need paths under ${input.leanWorkingDirectory}.` : ""} Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file; read a matching skill's SKILL.md completely. ${roleInstructions(input.session, true, AGENT_TOOL in input.tools)}`,
		leanToolInstructions(input.leanShape, { readOnly, codeMode }),
		codeMode === "primary"
			? primaryCodeModeInstructions(input.leanShape, { readOnly })
			: codeMode
				? codeModeInstructions(input.leanShape)
				: "",
		deferredToolsInstructions(input.deferredTools ?? [], { codeMode }),
		AGENT_TOOL in input.tools
			? orchestratorInstructions({
					codeMode,
					// A read-only subagent may start readers, never writers.
					readOnly: readOnly || isReaderRole(input.session.agentRole),
				})
			: "",
		// The desktop browser runs as the builder's user; readers do not drive it.
		readOnly
			? ""
			: leanVisualQaInstructions(LEAN_SHAPE_TOOLS[input.leanShape], {
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

/** A subagent's own role and budget, else the chat's or the task's role. */
function roleInstructions(
	session: Parameters<typeof agentTurnInstructions>[0]["session"],
	shellBuilder: boolean,
	delegates: boolean,
) {
	return session.agentRole
		? subagentRoleInstructions(session.agentRole, session.agentBudget ?? null)
		: cloudAgentRoleInstructions(session, { shellBuilder, delegates });
}
