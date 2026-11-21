import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	DESCRIBE_SECRET_TOOL,
	parseProjectSecretName,
	redactSecretValues,
	SECRET_DESCRIPTION_LIMIT,
} from "#/domain/project-secret";
import { redactToolText } from "#/domain/tool-detail";

export { DESCRIBE_SECRET_TOOL };

/**
 * Lets the agent keep what it learned by testing a secret (which service it is
 * for, whose identity, what it can do, how it was tested) on the secret itself.
 * Every later chat in the project then sees it beside the secret's name, so
 * the credential is identified once, whatever the provider. A description is
 * stored in the clear, so one that holds a secret value, or anything shaped
 * like one, is refused.
 */
export function describeSecretTools(input: {
	/** The turn's secret values (every tool result is redacted of them too). */
	readonly values: () => readonly string[];
	readonly save: (secret: {
		name: string;
		description: string;
	}) => Promise<"project" | "account" | null>;
}): ToolSet {
	return {
		[DESCRIBE_SECRET_TOOL]: tool({
			description:
				"Save what you learned about one of this project's secrets by testing it: the service it is for, whose identity it carries, what it can do, how you tested it and when. Every later chat in the project sees it beside the secret's name, so nobody has to test it again. Never include a secret value or part of one. A new value for the secret clears the description.",
			inputSchema: z.object({
				name: z
					.string()
					.min(1)
					.max(200)
					.describe("The secret's variable name."),
				description: z
					.string()
					.min(1)
					.max(SECRET_DESCRIPTION_LIMIT)
					.describe("One or two plain sentences; no values."),
			}),
			execute: async ({ name, description }) => {
				const text = description.trim();
				if (
					redactSecretValues(text, input.values()) !== text ||
					redactToolText(text) !== text
				)
					return {
						saved: false,
						error:
							"Not saved: the description contains something that looks like a secret value. Describe the service and what the credential can do, without any part of the value.",
					};
				const saved = await input.save({
					name: parseProjectSecretName(name),
					description: text,
				});
				if (!saved)
					return {
						saved: false,
						error: `This project has no secret named ${name}.`,
					};
				return {
					saved: true,
					name,
					note: `Saved on the ${saved === "account" ? "account-wide" : "project"} secret; later chats see it.`,
				};
			},
		}),
	};
}
