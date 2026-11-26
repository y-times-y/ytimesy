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

/** The versions a Worker serves, with their share of traffic. */
export type ServingVersions = readonly {
	readonly versionId: string;
	readonly percentage: number;
}[];

/**
 * The versions a Worker serves, from `wrangler deployments status --json`;
 * empty before its first deploy (nothing to roll back to).
 */
export function servingVersions(statusJson: string): ServingVersions {
	let status: unknown;
	try {
		status = JSON.parse(statusJson);
	} catch {
		return [];
	}
	const versions = (status as { versions?: unknown } | null)?.versions;
	if (!Array.isArray(versions)) return [];
	return versions.flatMap((row) => {
		const { version_id: versionId, percentage } = (row ?? {}) as {
			version_id?: unknown;
			percentage?: unknown;
		};
		return typeof versionId === "string" &&
			/^[0-9a-f-]{8,64}$/i.test(versionId) &&
			typeof percentage === "number" &&
			percentage > 0
			? [{ versionId, percentage }]
			: [];
	});
}

/**
 * The wrangler call that puts a Worker back on the versions it served before
 * this deploy, traffic split included. Each version keeps the code and
 * secrets it was uploaded with.
 */
export function rollbackStep(
	config: readonly string[],
	previous: ServingVersions,
): string[] {
	return [
		"versions",
		"deploy",
		...previous.map((row) => `${row.versionId}@${row.percentage}%`),
		"--yes",
		"--message",
		"Rolled back by deploy-production: the post-deploy smoke check failed.",
		...config,
	];
}

/** Printed after a deploy: what happened to work in flight. */
export const IN_FLIGHT_WORK_NOTE =
	"Running chat turns were not failed: each Worker took one new version, Durable Objects move to it once idle (or after the configured delay), and an interrupted step resumes from its checkpoint.";

const sameVersions = (a: ServingVersions, b: ServingVersions) =>
	a.length === b.length &&
	a.every((row) =>
		b.some(
			(other) =>
				other.versionId === row.versionId &&
				other.percentage === row.percentage,
		),
	);

/**
 * Whether a failed smoke check may roll a Worker back. Only while it still
 * serves exactly what this deploy put there: if another deploy (another
 * thread on another machine, so the per-machine lock cannot stop it) has
 * replaced it since, rolling back would undo that newer deploy.
 */
export function rollbackDecision(input: {
	readonly deployed: ServingVersions;
	readonly previous: ServingVersions;
	readonly current: ServingVersions;
}): "roll-back" | "superseded" | "already-previous" | "no-previous" {
	if (!input.previous.length) return "no-previous";
	if (sameVersions(input.current, input.previous)) return "already-previous";
	if (!input.deployed.length || !sameVersions(input.current, input.deployed))
		return "superseded";
	return "roll-back";
}
