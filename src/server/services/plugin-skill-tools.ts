import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { PluginSkill } from "#/domain/plugin-package";

/**
 * An installed plugin and its skills. A turn lists them without their bodies
 * (enabledPluginSkillIndex): `readBody` loads one from the install `id` when
 * the agent asks for it.
 */
type InstalledPlugin = {
	readonly plugin: string;
	readonly id?: string;
	readonly skills: readonly (Omit<PluginSkill, "body"> & {
		readonly body?: string;
	})[];
};

/** One line per skill in the system prompt; bodies load only when the agent asks. */
export function pluginSkillsInstructions(plugins: readonly InstalledPlugin[]) {
	const lines = plugins.flatMap(({ plugin, skills }) =>
		skills.map((skill) => `- ${plugin}:${skill.name}: ${skill.description}`),
	);
	return lines.length
		? `Installed plugin skills (load one with read_plugin_skill when it applies):\n${lines.join("\n")}`
		: "";
}

export function pluginSkillTools(
	plugins: readonly InstalledPlugin[],
	readBody?: (
		installId: string,
		skill: string,
	) => Promise<{ readonly body: string | undefined } | null>,
): ToolSet {
	if (!plugins.some((plugin) => plugin.skills.length)) return {};
	return {
		read_plugin_skill: tool({
			description:
				"Read the full instructions of an installed plugin skill listed in your instructions.",
			inputSchema: z.object({ plugin: z.string(), skill: z.string() }),
			execute: async ({ plugin, skill }) => {
				const installed = plugins.find(
					(candidate) => candidate.plugin === plugin,
				);
				const found = installed?.skills.find(
					(candidate) => candidate.name === skill,
				);
				if (!installed || !found)
					return { error: `No installed skill ${plugin}:${skill}.` };
				if (found.body !== undefined)
					return { plugin, skill, instructions: found.body };
				const read =
					installed.id && readBody
						? await readBody(installed.id, skill)
						: { body: found.body };
				return read
					? { plugin, skill, instructions: read.body }
					: { error: `No installed skill ${plugin}:${skill}.` };
			},
		}),
	};
}
