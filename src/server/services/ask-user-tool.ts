import { type JSONValue, type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	ASK_USER_TOOL,
	askedQuestions,
	USER_QUESTION_LIMITS,
} from "#/domain/user-question";

/** A successful question ends the turn; the user answers in the chat card. */
export const ASK_USER_END_TURN_TOOLS = [ASK_USER_TOOL] as const;

const L = USER_QUESTION_LIMITS;

/**
 * Lets the agent ask the user to choose when a decision is genuinely theirs.
 * Offered only in root chats, where a person can answer the card.
 */
export function askUserTools(): ToolSet {
	return {
		[ASK_USER_TOOL]: tool({
			description: `Ask the user to choose between options when a decision is genuinely theirs and you cannot infer it from the request, the code or reasonable defaults (for example which of two databases, or whether to keep a public API). Most ambiguity does not need this: pick the convention or the most reasonable reading, say which in your answer, and continue. The chat shows each question with its options as buttons, plus a field for their own answer; their reply arrives as the next user message. This ends your turn. Ask 1 to ${L.questions} short questions at once rather than one per turn, each with ${L.options.min} to ${L.options.max} distinct options; put a recommended option first and end its label with "(recommended)".`,
			inputSchema: z.object({
				questions: z
					.array(
						z.object({
							question: z
								.string()
								.min(1)
								.max(L.question)
								.describe("The full question, ending with a question mark."),
							header: z
								.string()
								.max(L.header)
								.optional()
								.describe(
									'A 1 to 3 word topic shown as a chip, e.g. "Database".',
								),
							options: z
								.array(
									z.object({
										label: z
											.string()
											.min(1)
											.max(L.label)
											.describe("1 to 5 words."),
										description: z
											.string()
											.max(L.description)
											.optional()
											.describe("One short line: what choosing it means."),
									}),
								)
								.min(L.options.min)
								.max(L.options.max),
							multiSelect: z
								.boolean()
								.optional()
								.describe("True when several options can be chosen together."),
						}),
					)
					.min(1)
					.max(L.questions),
			}),
			execute: async ({ questions }) => {
				const asked = askedQuestions({ asked: true, questions }, false);
				if (!asked)
					return {
						asked: false,
						error: `Each question needs text and ${L.options.min} to ${L.options.max} options with labels.`,
					};
				return { asked: true, questions: asked };
			},
			// The model wrote the questions; it needs only to stop.
			toModelOutput: ({ output }) => {
				const { questions: _questions, ...rest } = output as Record<
					string,
					unknown
				>;
				return {
					type: "json",
					value: {
						...rest,
						...(rest.asked
							? {
									next: "Stop here. The user's answer arrives as their next message.",
								}
							: {}),
					} as JSONValue,
				};
			},
		}),
	};
}
