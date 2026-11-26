import type { ToolSet } from "ai";
import {
	leanVisualQaInstructions,
	visualQaInstructions,
} from "#/domain/agent-desktop";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import { artifactInstructions } from "#/domain/artifact";
import { CANVAS_TOOL, canvasInstructions } from "#/domain/canvas";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import { BUILDER_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import type { FusionPairProfile } from "#/domain/fusion-pairs";
import {
	LEAN_SHAPE_TOOLS,
	type LeanToolShape,
} from "#/domain/harness-model-profile";
import type { LeadMode, LeadTools } from "#/domain/harness-variant";
import {
	codeModeInstructions,
	leanToolInstructions,
	primaryCodeModeInstructions,
} from "#/domain/lean-tool-instructions";
import {
	BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS,
	PROJECT_KNOWLEDGE_INSTRUCTIONS,
} from "#/domain/project-knowledge";
import {
	DESCRIBE_SECRET_TOOL,
	projectSecretsInstructions,
} from "#/domain/project-secret";
import {
	RIGOR_BUILDER_INSTRUCTIONS,
	RIGOR_LEAD_REQUIREMENTS,
	RIGOR_REQUIREMENTS_INSTRUCTIONS,
} from "#/domain/rigor";
import { isSideChat, sideChatInstructions } from "#/domain/side-chat";
import {
	AGENT_TOOL,
	isReaderRole,
	type SubagentBudget,
	type SubagentRole,
} from "#/domain/subagent";
import {
	fusionLeadInstructions,
	fusionThinLeadInstructions,
	HANDOFF_INSTRUCTIONS,
	orchestratorInstructions,
	sidekickRoleInstructions,
	subagentRoleInstructions,
} from "#/domain/subagent-instructions";
import { yInstructions } from "#/domain/y-agent";
import { superAgentInstructions } from "#/domain/y-squared";
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
	/** Harness variant leadTools: thin gives the lead the thin block (callers pass the variant's). */
	leadTools?: LeadTools;
	/** The Harbor bridge: the lead's agent calls block until the round's report. */
	leadBlocking?: boolean;
	/** Lead mode fusion: the lead/sidekick pair's tuning (src/domain/fusion-pairs.ts). */
	fusionPair?: FusionPairProfile;
	/** Harness variant rigor=on: the rigor block for agents that change files. */
	rigor?: boolean;
	/** Harness variant subagents=force: the root builder must delegate at least once. */
	forceDelegation?: boolean;
	/** The Harbor bridge's root builder: brief final answer, no desktop browser block. */
	unattended?: boolean;
	/** Unattended runs: the check-in-proportion rule (default on). */
	checkInProportion?: boolean;
	/** Replaces the subagent section (the Harbor bridge's read-only helpers). */
	helperInstructions?: string;
	/** Harness variant y=on: the root chat is Y, which only delegates (src/domain/y-agent.ts). */
	y?: boolean;
	/** The project's pinned Y² chat (src/domain/y-squared.ts): it only reads the threads and reports. */
	ySquared?: boolean;
	/** A captain of the project (src/domain/captain.ts): Y²'s instructions behind its role. */
	captain?: { name: string; label: string | null; rolePrompt: string } | null;
}) {
	if (input.ySquared && !input.session.agentRole)
		return superAgentInstructions(input.captain);
	if (input.y && !input.session.agentRole) return yTurnInstructions(input);
	if (input.leanShape)
		return leanTurnInstructions({ ...input, leanShape: input.leanShape });
	const { session, tools, plugins, projectKnowledge, secretNames } = input;
	return `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file with cat; read a matching skill's SKILL.md completely. ${BUILDER_ENVIRONMENT_INSTRUCTIONS} ${roleInstructions(session, AGENT_TOOL in tools)}${"browser_screenshot" in tools ? ` ${visualQaInstructions()}` : ""}${CANVAS_TOOL in tools ? `\n${canvasInstructions()}` : ""}\n${artifactInstructions()}\n${pluginSkillsInstructions(plugins)}${secretNames?.length ? `\n${projectSecretsInstructions(secretNames, { describeTool: DESCRIBE_SECRET_TOOL in tools })}` : ""}${rigorApplies(input) ? `\n${rigorBlock(input)}` : ""}${projectKnowledge === null ? "" : `\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`}`;
}

/** Y's system prompt: its role and the project's secret names, never the builder's tool guidance. */
function yTurnInstructions(input: Parameters<typeof agentTurnInstructions>[0]) {
	const secrets = input.secretNames?.length
		? projectSecretsInstructions(input.secretNames)
		: "";
	return secrets ? `${yInstructions()}\n${secrets}` : yInstructions();
}

/** The rigor block goes to the root builder and writers, never to readers. */
function rigorApplies(input: Parameters<typeof agentTurnInstructions>[0]) {
	return (
		!!input.rigor &&
		!input.leanReadOnly &&
		!isReaderRole(input.session.agentRole)
	);
}

/** The rigor block; the root builder (a fusion lead included) also writes the requirements list. */
function rigorBlock(input: Parameters<typeof agentTurnInstructions>[0]) {
	if (input.session.agentRole) return RIGOR_BUILDER_INSTRUCTIONS;
	return [
		RIGOR_BUILDER_INSTRUCTIONS,
		RIGOR_REQUIREMENTS_INSTRUCTIONS,
		input.lead === "fusion" && AGENT_TOOL in input.tools
			? RIGOR_LEAD_REQUIREMENTS
			: "",
	]
		.filter(Boolean)
		.join("\n");
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
	// The thin fusion lead's block names its few tools; the workspace commands are its writer's.
	const thinLead =
		input.lead === "fusion" &&
		!input.session.agentRole &&
		input.leadTools === "thin" &&
		AGENT_TOOL in input.tools;
	return [
		`You are the ytimesy coding agent, working in this task's prepared repository checkout${input.leanWorkingDirectory ? ` at ${input.leanWorkingDirectory}` : ""}; commands start in the repository root and relative paths resolve there.${input.leanWorkingDirectory ? ` Tools that take absolute paths need paths under ${input.leanWorkingDirectory}.` : ""} Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file; read a matching skill's SKILL.md completely. ${roleInstructions(input.session, AGENT_TOOL in input.tools, input.unattended, input.checkInProportion)}`,
		thinLead
			? ""
			: leanToolInstructions(input.leanShape, {
					readOnly,
					codeMode,
					unattended: input.unattended,
					// A subagent's work reaches GitHub only through its parent.
					gitRemote: !input.session.agentRole,
				}),
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
			? thinLead
				? fusionThinLeadInstructions({
						inspect: LEAN_SHAPE_TOOLS[input.leanShape].command,
						read: (
							LEAN_SHAPE_TOOLS[input.leanShape] as Partial<
								Record<string, string>
							>
						).read,
						pair: input.fusionPair,
						blocking: input.leadBlocking,
					})
				: input.lead === "fusion" && !input.session.agentRole
					? fusionLeadInstructions({
							editTools: leanEditTools(input.leanShape, input.tools),
							readTool: (
								LEAN_SHAPE_TOOLS[input.leanShape] as Partial<
									Record<string, string>
								>
							).read,
							pair: input.fusionPair,
						})
					: input.helperInstructions && !input.session.agentRole
						? input.helperInstructions
						: orchestratorInstructions({
								codeMode,
								force: !!input.forceDelegation && !input.session.agentRole,
								main: !input.session.agentRole,
								// A read-only subagent may start readers, never writers.
								readOnly: readOnly || isReaderRole(input.session.agentRole),
							})
			: // Main without helpers still hands off its background commands.
				input.session.agentRole
				? ""
				: HANDOFF_INSTRUCTIONS,
		rigorApplies(input) ? rigorBlock(input) : "",
		// The desktop browser runs as the builder's user; readers do not drive it.
		readOnly || thinLead || input.unattended
			? ""
			: leanVisualQaInstructions(LEAN_SHAPE_TOOLS[input.leanShape], {
					prEvidence: input.prEvidence,
				}),
		CANVAS_TOOL in input.tools ? canvasInstructions() : "",
		artifactInstructions(),
		pluginSkillsInstructions(input.plugins),
		input.secretNames?.length
			? projectSecretsInstructions(input.secretNames, {
					describeTool: DESCRIBE_SECRET_TOOL in input.tools,
				})
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
	unattended?: boolean,
	checkInProportion?: boolean,
) {
	if (isSideChat(session)) return sideChatInstructions();
	if (session.agentRole === "writer" && session.agentBudget?.sidekick)
		return sidekickRoleInstructions(session.agentBudget);
	return session.agentRole
		? subagentRoleInstructions(session.agentRole, session.agentBudget ?? null)
		: cloudAgentRoleInstructions({ delegates, unattended, checkInProportion });
}
