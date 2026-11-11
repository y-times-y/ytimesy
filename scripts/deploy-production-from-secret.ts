import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseProductionEnvSecret,
	productionEnvFileText,
} from "./production-env-secret";

/**
 * Deploys production from any chat, using the account secrets every project
 * receives: PRODUCTION_ENV_FILE (the production env file), CLOUDFLARE_DEPLOY_TOKEN
 * (the Cloudflare token that may deploy the Workers) and SUPABASE_CA_CERT.
 *
 *   node --import tsx scripts/deploy-production-from-secret.ts --preflight-only
 *   node --import tsx scripts/deploy-production-from-secret.ts --confirm-production
 *
 * Every argument goes to scripts/deploy-production.ts, which keeps all its own
 * checks (the checkout must be origin/main, no pending migration, no running
 * turn without --allow-running-turns). This only gives it what it needs:
 *
 * - the env file rebuilt from the secret, in a private temporary folder that
 *   is deleted afterwards, whatever happens;
 * - a clean environment, so the chat's own DATABASE_URL (its development
 *   database) cannot win over the production one: `node --env-file` never
 *   overrides a variable that is already set;
 * - YTIMESY_GO_LIVE=1, because production already serves the app host.
 */
const missing = [
	"PRODUCTION_ENV_FILE",
	"CLOUDFLARE_DEPLOY_TOKEN",
	"SUPABASE_CA_CERT",
].filter((name) => !process.env[name]);
if (missing.length)
	throw new Error(
		`This chat does not have ${missing.join(", ")}. They are account secrets, shared with every project of the account; a chat started before they were added needs a new step to receive them.`,
	);

const folder = mkdtempSync(join(tmpdir(), "ytimesy-production-"));
try {
	const certificate = join(folder, "supabase-ca.crt");
	const envFile = join(folder, "production.env");
	writeFileSync(certificate, process.env.SUPABASE_CA_CERT as string, {
		mode: 0o644,
	});
	writeFileSync(
		envFile,
		productionEnvFileText(
			parseProductionEnvSecret(process.env.PRODUCTION_ENV_FILE as string),
			certificate,
		),
		{ mode: 0o600 },
	);
	const deploy = spawnSync(
		process.execPath,
		[
			`--env-file=${envFile}`,
			"--import",
			"tsx",
			join(import.meta.dirname, "deploy-production.ts"),
			...process.argv.slice(2),
		],
		{
			stdio: "inherit",
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_DEPLOY_TOKEN,
				YTIMESY_GO_LIVE: "1",
			},
		},
	);
	process.exitCode = deploy.status ?? 1;
} finally {
	rmSync(folder, { recursive: true, force: true });
}
