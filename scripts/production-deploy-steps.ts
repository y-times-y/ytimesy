/**
 * The wrangler calls a production deploy makes, per Worker: one `deploy`
 * that uploads the code and its secrets as a single version
 * (`--secrets-file`, additive: secrets it omits are kept).
 *
 * Before, `secret bulk` then `deploy` made two versions per Worker, and each
 * replaced the running one: a secret change restarts a Worker's Durable
 * Objects at once, so a deploy interrupted running chat steps twice, and a
 * `deploy` that then failed left the new secrets running beside the old code.
 */
export function productionDeploySteps(input: {
	readonly edgeConfig: readonly string[];
	readonly webConfig: readonly string[];
	readonly edgeSecretsFile: string;
	readonly webSecretsFile: string;
}): string[][] {
	return [
		// Edge first: the web Worker's EXECUTOR service binding targets it.
		["deploy", "--secrets-file", input.edgeSecretsFile, ...input.edgeConfig],
		["deploy", "--secrets-file", input.webSecretsFile, ...input.webConfig],
	];
}

/** Printed after a deploy: what happened to work in flight. */
export const IN_FLIGHT_WORK_NOTE =
	"Running chat turns were not failed: each Worker took one new version, Durable Objects move to it once idle (or after the configured delay), and an interrupted step resumes from its checkpoint.";
