import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { symmetricEncrypt } from "better-auth/crypto";
import { Pool } from "pg";
import { closeDatabase, database } from "../../src/server/adapters/database";
import { codexAccessTokenExpiresAt } from "../../src/server/auth/codex-managed-auth";
import { unseal } from "../../src/server/auth/token-vault";
import { runEvaluatorCommand } from "./grader";

async function command(argv: string[]) {
	const result = await runEvaluatorCommand(argv, {
		cwd: process.cwd(),
		timeoutMs: 120000,
	});
	if (result.code)
		throw new Error(`Operator prerequisite failed: ${argv[0]} ${argv[1]}`);
	return result.stdout.trim();
}

/** Copies only the genuine operator identity and encrypted, access-only Codex
 * credential into an owned loopback database. No source database mutations,
 * GitHub authority, refresh token, or production job queue is copied. */
export async function createOperatorEvaluationDatabase(directory: string) {
	const reference = (
		await readFile("supabase/.temp/project-ref", "utf8")
	).trim();
	const sourceUrl = new URL(process.env.DATABASE_URL ?? "");
	if (
		reference !== "exampledevprojectref" ||
		!sourceUrl.username.includes(reference)
	)
		throw new Error("Expected the linked development credential source.");
	const cert = sourceUrl.searchParams.get("sslrootcert");
	if (cert) sourceUrl.searchParams.set("sslrootcert", resolve(cert));
	process.env.DATABASE_URL = sourceUrl.toString();
	const result = await database().query<{
		id: string;
		name: string;
		email: string;
		encrypted_codex_auth: string;
		plan_type: string;
	}>(
		`select u.id,u.name,u.email,a.encrypted_codex_auth,a.plan_type from auth_user u join agent_account a on a.user_id=u.id where a.provider='codex' and a.status='connected' and ($1::text is null or u.id=$1)`,
		[process.env.YTIMESY_EVALUATION_USER_ID ?? null],
	);
	if (result.rows.length !== 1)
		throw new Error("Select exactly one connected evaluation owner.");
	const owner = result.rows[0];
	const auth = JSON.parse(await unseal(owner.encrypted_codex_auth));
	await closeDatabase();
	if (codexAccessTokenExpiresAt(auth) < Date.now() + 2 * 3600000)
		throw new Error(
			"Codex access needs two hours remaining; this pilot cannot rotate the source refresh credential.",
		);
	auth.tokens.refresh_token = "unavailable-in-isolated-evaluation";
	const secret = randomBytes(32).toString("hex");
	const encryptedAuth = await symmetricEncrypt({
		key: secret,
		data: JSON.stringify(auth),
	});
	const password = randomBytes(32).toString("hex");
	const container = `ytimesy-terminal-bench-db-${randomUUID()}`;
	let local: Pool | undefined;
	let created = false;
	try {
		await command(["docker", "image", "inspect", "postgres:13"]);
		await command([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(directory, "server.key"),
			"-out",
			join(directory, "server.crt"),
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		]);
		await command([
			"docker",
			"run",
			"--detach",
			"--name",
			container,
			"--label",
			"ytimesy.evaluation=terminal-bench",
			"--memory",
			"512m",
			"--cpus",
			"1",
			"-e",
			`POSTGRES_PASSWORD=${password}`,
			"-p",
			"127.0.0.1::5432",
			"--mount",
			`type=bind,source=${directory},target=/operator-cert,readonly`,
			"postgres:13",
			"bash",
			"-c",
			"cp /operator-cert/server.key /tmp/evaluation.key && cp /operator-cert/server.crt /tmp/evaluation.crt && chown postgres:postgres /tmp/evaluation.key /tmp/evaluation.crt && chmod 600 /tmp/evaluation.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/evaluation.crt -c ssl_key_file=/tmp/evaluation.key",
		]);
		created = true;
		const binding = await command(["docker", "port", container, "5432/tcp"]);
		if (!/^127\.0\.0\.1:\d+$/.test(binding))
			throw new Error("Evaluation PostgreSQL is not loopback-only.");
		const url = new URL(
			`postgresql://postgres:${password}@${binding}/postgres`,
		);
		url.searchParams.set("sslmode", "verify-full");
		url.searchParams.set("sslrootcert", join(directory, "server.crt"));
		local = new Pool({ connectionString: url.toString(), max: 4 });
		let ready = false;
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				await local.query("select 1");
				ready = true;
				break;
			} catch {
				await new Promise((done) => setTimeout(done, 1000));
			}
		}
		if (!ready) throw new Error("Evaluation database startup failed.");
		await local.query("create role anon; create role authenticated");
		for (const file of (await readdir("supabase/migrations"))
			.filter((name) => name.endsWith(".sql"))
			.sort())
			await local.query(await readFile(`supabase/migrations/${file}`, "utf8"));
		await local.query(
			'insert into auth_user(id,name,email,"emailVerified") values($1,$2,$3,true)',
			[owner.id, owner.name, owner.email],
		);
		await local.query(
			"insert into agent_account(user_id,provider,status,encrypted_codex_auth,plan_type) values($1,'codex','connected',$2,$3)",
			[owner.id, encryptedAuth, owner.plan_type],
		);
		return {
			userId: owner.id,
			databaseUrl: url.toString(),
			secret,
			pool: local,
			async close() {
				await local?.end();
				await command(["docker", "rm", "--force", container]);
			},
		};
	} catch (error) {
		await local?.end();
		if (created) await command(["docker", "rm", "--force", container]);
		throw error;
	}
}
