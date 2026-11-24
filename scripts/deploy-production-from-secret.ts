import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseProductionEnvSecret,
	productionEnvFileText,
} from "./production-env-secret";
import {
	IDENTIFIER_FILES,
	liveProductionIdentifiers,
	withProductionIdentifiers,
} from "./production-identifiers";

/**
 * Deploys production from any chat, using the account secrets every project
 * receives: PRODUCTION_ENV_FILE (the production env file), CLOUDFLARE_DEPLOY_TOKEN
 * (the Cloudflare token that may deploy the Workers) and SUPABASE_CA_CERT.
 *
 *   node --import tsx scripts/deploy-production-from-secret.ts --preflight-only
 *   node --import tsx scripts/deploy-production-from-secret.ts --confirm-production
 *
 * Every argument goes to scripts/deploy-production.ts, which keeps all its own
 * checks (the checkout must be origin/main, no pending migration, running
 * turns are reported, not a reason to wait). This only gives it what it needs:
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

/**
 * The real identifiers over the public placeholders, as the overlay patch
 * scripts/deploy-production.ts applies after its source checks (and reverses
 * after the deploy). A machine's own private overlay still wins; without one
 * the patch is built from the live account (scripts/production-identifiers.ts),
 * so any chat can deploy. Built from the checked-out files only when they have
 * no local change, so it carries nothing but the identifiers.
 */
async function liveOverlay(folder: string): Promise<string | null> {
	const own =
		process.env.YTIMESY_PRODUCTION_OVERLAY ||
		join(
			process.env.HOME ?? "",
			".ytimesy-private",
			"production-overlay.patch",
		);
	if (existsSync(own)) return null;
	const changed = execFileSync(
		"git",
		["status", "--porcelain", "--", ...IDENTIFIER_FILES],
		{ encoding: "utf8" },
	).trim();
	if (changed)
		throw new Error(
			`Local changes in ${IDENTIFIER_FILES.join(", ")}; deploy from a clean checkout of origin/main.`,
		);
	const ids = await liveProductionIdentifiers(
		process.env.CLOUDFLARE_DEPLOY_TOKEN as string,
	);
	const originals = IDENTIFIER_FILES.map(
		(file) => [file, readFileSync(file, "utf8")] as const,
	);
	let patch: string;
	try {
		for (const [file, text] of originals)
			writeFileSync(file, withProductionIdentifiers(file, text, ids));
		patch = execFileSync("git", ["diff", "--", ...IDENTIFIER_FILES], {
			encoding: "utf8",
		});
	} finally {
		for (const [file, text] of originals) writeFileSync(file, text);
	}
	const path = join(folder, "production-overlay.patch");
	writeFileSync(path, patch, { mode: 0o600 });
	console.log(
		"Built the production overlay from the live account (account, Hyperdrive and database identifiers).",
	);
	return path;
}

const folder = mkdtempSync(join(tmpdir(), "ytimesy-production-"));
try {
	const overlay = await liveOverlay(folder);
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
				// The migration check (scripts/db-migrate.ts) reads the certificate
				// itself; --preflight-only never reaches it.
				SUPABASE_CA_CERT: process.env.SUPABASE_CA_CERT,
				YTIMESY_GO_LIVE: "1",
				// Who uploads the Workers, and the one-time takeover of Workers made
				// before the infra/alchemy stacks existed (docs/infrastructure-as-code.md).
				...(process.env.YTIMESY_DEPLOY_ENGINE
					? { YTIMESY_DEPLOY_ENGINE: process.env.YTIMESY_DEPLOY_ENGINE }
					: {}),
				...(process.env.YTIMESY_INFRA_ADOPT
					? { YTIMESY_INFRA_ADOPT: process.env.YTIMESY_INFRA_ADOPT }
					: {}),
				...(overlay ? { YTIMESY_PRODUCTION_OVERLAY: overlay } : {}),
			},
		},
	);
	process.exitCode = deploy.status ?? 1;
} finally {
	rmSync(folder, { recursive: true, force: true });
}
