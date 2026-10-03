import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, database } from "#/server/adapters/database";

const version = "20261001120000";
const projectRef = "zqkptvyvoyqqtpihlshw";
if (!process.argv.includes("--apply"))
	throw new Error("Explicit --apply is required for development rollout.");
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
const target = new URL(process.env.DATABASE_URL ?? "");
if (linked !== projectRef || !target.username.includes(projectRef))
	throw new Error("Database is not the approved linked development project.");
const sql = await readFile(
	`supabase/migrations/${version}_conversation_delivery.sql`,
	"utf8",
);
const client = await database().connect();
try {
	await client.query("begin");
	await client.query("select pg_advisory_xact_lock(81738420)");
	const previous = await client.query(
		"select version from supabase_migrations.schema_migrations where version=$1",
		[version],
	);
	if (!previous.rowCount) {
		await client.query(sql);
		await client.query(
			"insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
			[version, "conversation_delivery", [sql]],
		);
	}
	await client.query("commit");
	console.info(`Development migration ${version} is applied.`);
} catch (error) {
	await client.query("rollback");
	throw error;
} finally {
	client.release();
	await closeDatabase();
}

const privatePath = ".ytimesy/realtime-development.json";
let secret: string;
try {
	const previous = JSON.parse(await readFile(privatePath, "utf8"));
	if (typeof previous.secret !== "string" || previous.secret.length < 32)
		throw new Error("Existing development signing key is invalid.");
	secret = previous.secret;
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	secret = randomBytes(48).toString("hex");
}
const temporary = await mkdtemp(join(tmpdir(), "ytimesy-relay-secrets-"));
try {
	const secretsPath = join(temporary, "secrets.json");
	await writeFile(secretsPath, JSON.stringify({ DELIVERY_SECRET: secret }), {
		mode: 0o600,
	});
	const deployment = spawnSync(
		"pnpm",
		[
			"exec",
			"wrangler",
			"deploy",
			"--config",
			"wrangler.realtime.jsonc",
			"--secrets-file",
			secretsPath,
		],
		{ encoding: "utf8" },
	);
	console.info(deployment.stdout);
	if (deployment.status !== 0) {
		console.error(deployment.stderr);
		throw new Error(
			"Development relay deployment failed; migration remains additive and applied.",
		);
	}
	const url = deployment.stdout.match(
		/https:\/\/ytimesy-realtime-development\.[a-z0-9-]+\.workers\.dev/,
	)?.[0];
	if (!url) throw new Error("Deployment returned no verified development URL.");
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(privatePath, JSON.stringify({ url, secret }), {
		mode: 0o600,
	});
	console.info(`Private local configuration saved; development relay: ${url}`);
} finally {
	await rm(temporary, { recursive: true });
}
