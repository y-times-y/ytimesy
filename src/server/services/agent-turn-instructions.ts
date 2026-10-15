import type { ToolSet } from "ai";
import { visualQaInstructions } from "#/domain/agent-desktop";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import {
	BUILDER_ENVIRONMENT_INSTRUCTIONS,
	PREPARED_ENVIRONMENT_INSTRUCTIONS,
} from "#/domain/environment-context";
import { PROJECT_KNOWLEDGE_INSTRUCTIONS } from "#/domain/project-knowledge";
import { pluginSkillsInstructions } from "./plugin-skill-tools";

/** The system instructions of an API-harness turn, before the per-family tool profile. */
export function agentTurnInstructions(input: {
	shellBuilder: boolean;
	session: Parameters<typeof cloudAgentRoleInstructions>[0];
	tools: ToolSet;
	plugins: Parameters<typeof pluginSkillsInstructions>[0];
	projectKnowledge: string | null;
}) {
	const { shellBuilder, session, tools, plugins, projectKnowledge } = input;
	return `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository.${shellBuilder ? " Repository instructions (AGENTS.md/CLAUDE.md), nested instruction file locations and skills are provided in the conversation. Before working in a folder listed with its own AGENTS.md or CLAUDE.md, read that file with cat; read a matching skill's SKILL.md completely." : " Call read_repository_guidance before implementation and for nested paths; read applicable instructions and skill bodies completely. Search optional tools with search_tools."} ${shellBuilder ? BUILDER_ENVIRONMENT_INSTRUCTIONS : `${PREPARED_ENVIRONMENT_INSTRUCTIONS} Use read_environment_report for that setup report; do not pass its /tmp path to repository file readers.`} ${cloudAgentRoleInstructions(session, { shellBuilder })}${shellBuilder && "browser_screenshot" in tools ? ` ${visualQaInstructions()}` : ""}\n${pluginSkillsInstructions(plugins)}${projectKnowledge === null ? "" : `\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`}`;
}
