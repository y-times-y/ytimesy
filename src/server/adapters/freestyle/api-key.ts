import { Effect } from "effect";
import { MissingFreestyleApiKey } from "#/server/services/errors";

export function readFreestyleApiKey(
	env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, MissingFreestyleApiKey> {
	const apiKey = env.FREESTYLE_API_KEY?.trim();
	if (!apiKey) {
		return Effect.fail(
			new MissingFreestyleApiKey({
				message: "FREESTYLE_API_KEY is not set",
			}),
		);
	}
	return Effect.succeed(apiKey);
}
