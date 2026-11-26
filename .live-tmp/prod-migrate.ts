// Scratch: runs scripts/db-migrate.ts against PRODUCTION with a clean environment, as the deploy does.
// Prints only the host name. Usage: node --import tsx .live-tmp/prod-migrate.ts [--apply --only <file>]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProductionEnvSecret, productionEnvFileText } from "../scripts/production-env-secret.ts";

const folder = mkdtempSync(join(tmpdir(), "ytimesy-migrate-"));
try {
	const cert = join(folder, "supabase-ca.crt");
	writeFileSync(cert, process.env.SUPABASE_CA_CERT as string);
	const envFile = join(folder, "production.env");
	const text = productionEnvFileText(parseProductionEnvSecret(process.env.PRODUCTION_ENV_FILE as string), cert);
	writeFileSync(envFile, text, { mode: 0o600 });
	const line = text.split("\n").find((l) => l.startsWith("DATABASE_URL=")) ?? "";
	try { console.log("target host:", new URL(line.slice(13).replace(/^"|"$/g, "")).host); } catch { console.log("target host: ?"); }
	const run = spawnSync(process.execPath, [`--env-file=${envFile}`, "--import", "tsx", process.argv[2] === "--query" ? ".live-tmp/q.ts" : "scripts/db-migrate.ts", ...process.argv.slice(process.argv[2] === "--query" ? 3 : 2)], {
		stdio: "inherit",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_CA_CERT: process.env.SUPABASE_CA_CERT },
	});
	process.exitCode = run.status ?? 1;
} finally {
	rmSync(folder, { recursive: true, force: true });
}
