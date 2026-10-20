import type { ToolSet } from "ai";
import { redactSecretValues } from "#/domain/project-secret";

/**
 * Replaces runtime secret values in every tool result and error before the
 * model, lifecycle hooks or the chat see them. `secrets` is read on each
 * call: a turn adds values (the memory clone's token) after its tools exist.
 */
export function withRedactedResults(
	tools: ToolSet,
	secrets: readonly string[],
): ToolSet {
	const redact = <T>(value: T) =>
		secrets.length ? redactSecretValues(value, secrets) : value;
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: async (...args: Parameters<typeof execute>) => {
						try {
							const result = await execute(...args);
							if (
								result &&
								typeof result === "object" &&
								Symbol.asyncIterator in result
							)
								return (async function* () {
									for await (const part of result as AsyncIterable<unknown>)
										yield redact(part);
								})();
							return redact(result);
						} catch (cause) {
							if (cause instanceof Error) {
								const redacted = new Error(redact(cause.message));
								redacted.name = cause.name;
								throw redacted;
							}
							throw redact(cause);
						}
					},
				},
			];
		}),
	) as ToolSet;
}
