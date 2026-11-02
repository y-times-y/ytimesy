import { createHmac } from "node:crypto";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * A key the web and the edge share to sign one kind of request: the explicit
 * setting when present, else (outside production) one derived from
 * BETTER_AUTH_SECRET under the development label, which the development
 * deploys upload to the edge. Production never derives: its deploy uploads
 * production-labelled keys (scripts/deploy-production.ts), and a missing one
 * must fail loudly rather than sign with a key the production edge refuses.
 */
export function edgeSigningSecret(
	name: string,
	purpose: string,
	env: Environment = process.env,
): string | undefined {
	const explicit = env[name];
	if (explicit) return explicit;
	if (env.YTIMESY_ENVIRONMENT === "production")
		throw new Error(
			`Production requires ${name}; a development-derived key is never used.`,
		);
	const root = env.BETTER_AUTH_SECRET;
	if (!root || root.length < 32) return undefined;
	return createHmac("sha256", root)
		.update(`ytimesy:${purpose}:development:v1`)
		.digest("hex");
}
