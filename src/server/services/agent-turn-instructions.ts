import type { ToolSet } from "ai";
import {
	leanVisualQaInstructions,
	visualQaInstructions,
} from "#/domain/agent-desktop";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import { BUILDER_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import type { FusionPairProfile } from "#/domain/fusion-pairs";
import {
	LEAN_SHAPE_TOOLS,
	type LeanToolShape,
} from "#/domain/harness-model-profile";
import type { LeadMode } from "#/domain/harness-variant";
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
import { RIGOR_BUILDER_INSTRUCTIONS } from "#/domain/rigor";
import {
	AGENT_TOOL,
	isReaderRole,
	type SubagentBudget,
	type SubagentRole,
} from "#/domain/subagent";
import {
	fusionLeadInstructions,
	orchestratorInstructions,
	sidekickRoleInstructions,
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
	/** A read-only subagent's lean surface: commands and reads, no file-changing tools. */
	leanReadOnly?: boolean;
	/** The repository's absolute path on the workspace (lean surfaces state it). */
	leanWorkingDirectory?: string;
	/** Tools only run_code can call (deferred-tools.ts), listed so the model knows they exist. */
	deferredTools?: readonly DeferredToolEntry[];
	/** Harness variant codeMode (with run_code in the tools): primary teaches run_code as the main tool. */
	codeMode?: "on" | "primary";
	/** Harness variant prEvidence=on: one line on `ytimesy-evidence`. */
	prEvidence?: boolean;
	/** Harness variant lead: fusion gives the root builder the lead's block. */
	lead?: LeadMode;
	/** Lead mode fusion: the lead/sidekick pair's tuning (src/domain/fusion-pairs.ts). */
	fusionPair?: FusionPairProfile;
	/** Harness variant rigor=on: the rigor block for agents that change files. */
	rigor?: boolean;
}) {
	if (input.leanShape)
		return leanTurnInstructions({ ...input, leanShape: input.leanShape });
	const { session, tools, plugins, projectKnowledge, secretNames } = input;
	return `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file with cat; read a matching skill's SKILL.md completely. ${BUILDER_ENVIRONMENT_INSTRUCTIONS} ${roleInstructions(session, AGENT_TOOL in tools)}${"browser_screenshot" in tools ? ` ${visualQaInstructions()}` : ""}\n${pluginSkillsInstructions(plugins)}${secretNames?.length ? `\n${projectSecretsInstructions(secretNames)}` : ""}${rigorApplies(input) ? `\n${RIGOR_BUILDER_INSTRUCTIONS}` : ""}${projectKnowledge === null ? "" : `\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`}`;
}

/** The rigor block goes to the root builder and writers, never to readers. */
function rigorApplies(input: Parameters<typeof agentTurnInstructions>[0]) {
	return (
		!!input.rigor &&
		!input.leanReadOnly &&
		!isReaderRole(input.session.agentRole)
	);
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
		`You are the ytimesy coding agent, working in this task's prepared repository checkout${input.leanWorkingDirectory ? ` at ${input.leanWorkingDirectory}` : ""}; commands start in the repository root and relative paths resolve there.${input.leanWorkingDirectory ? ` Tools that take absolute paths need paths under ${input.leanWorkingDirectory}.` : ""} Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file; read a matching skill's SKILL.md completely. ${roleInstructions(input.session, AGENT_TOOL in input.tools)}`,
		leanToolInstructions(input.leanShape, { readOnly, codeMode }),
		codeMode === "primary"
			? primaryCodeModeInstructions(input.leanShape, { readOnly })
			: codeMode
				? codeModeInstructions(input.leanShape)
				: "",
		// Only code mode primary defers tools the prompt lists (MCP search/call).
		codeMode === "primary"
			? deferredToolsInstructions(input.deferredTools ?? [])
			: "",
		AGENT_TOOL in input.tools
			? input.lead === "fusion" && !input.session.agentRole
				? fusionLeadInstructions({
						editTools: leanEditTools(input.leanShape, input.tools),
						readTool: (
							LEAN_SHAPE_TOOLS[input.leanShape] as Partial<
								Record<string, string>
							>
						).read,
						pair: input.fusionPair,
					})
				: orchestratorInstructions({
						codeMode,
						// A read-only subagent may start readers, never writers.
						readOnly: readOnly || isReaderRole(input.session.agentRole),
					})
			: "",
		rigorApplies(input) ? RIGOR_BUILDER_INSTRUCTIONS : "",
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

/** The surface's file-editing tools that this turn offers (the lead's take-over tools). */
function leanEditTools(shape: LeanToolShape, tools: ToolSet) {
	const names = LEAN_SHAPE_TOOLS[shape] as Partial<Record<string, string>>;
	return [...new Set([names.edit, names.write])].filter(
		(name): name is string => !!name && name in tools,
	);
}

/** A subagent's own role and budget, else the root chat's role. */
function roleInstructions(
	session: Parameters<typeof agentTurnInstructions>[0]["session"],
	delegates: boolean,
) {
	if (session.agentRole === "writer" && session.agentBudget?.sidekick)
		return sidekickRoleInstructions(session.agentBudget);
	return session.agentRole
		? subagentRoleInstructions(session.agentRole, session.agentBudget ?? null)
		: cloudAgentRoleInstructions({ delegates });
}
