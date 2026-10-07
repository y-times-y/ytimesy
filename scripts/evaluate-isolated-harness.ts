import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import {
	chmod,
	mkdir,
	open,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { symmetricEncrypt } from "better-auth/crypto";
import { createTwoFilesPatch } from "diff";
import { build } from "esbuild";
import { Freestyle, FreestyleApiError } from "freestyle";
import { Pool } from "pg";
import ts from "typescript";
import {
	gradeEvaluationPatches,
	runEvaluatorCommand,
} from "../benchmarks/evaluation/grader";
import { runPairedEvaluation } from "../benchmarks/evaluation/run";
import { pinnedCodexInstallCommand } from "../src/domain/guest-cli-pin";
import { posixShellCommand } from "../src/domain/posix-command";
import { closeDatabase, database } from "../src/server/adapters/database";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { codexAccessTokenExpiresAt } from "../src/server/auth/codex-managed-auth";
import { unseal } from "../src/server/auth/token-vault";
import { closeJobQueueForTests } from "../src/server/jobs/queue";

const [flag, capText, developmentRoot, outputPath] = process.argv.slice(2);
const cap = Number(capText);
if (
	flag !== "--live" ||
	!Number.isFinite(cap) ||
	cap < 1 ||
	cap > 10 ||
	!developmentRoot ||
	!outputPath
)
	throw new Error(
		"Usage: evaluate-isolated-harness --live <approved-USD-1-to-10> <development-root> <new-private-directory>",
	);
const userId = process.env.YTIMESY_EVALUATION_USER_ID;
if (!userId) throw new Error("Evaluation owner is required.");
const sourceRoot = resolve(developmentRoot);
const target = new URL(process.env.DATABASE_URL ?? "");
const reference = (
	await readFile(join(sourceRoot, "supabase/.temp/project-ref"), "utf8")
).trim();
if (
	reference !== "zqkptvyvoyqqtpihlshw" ||
	!target.username.includes(reference)
)
	throw new Error("Not the approved development source.");
const sourceCertificate = target.searchParams.get("sslrootcert");
if (sourceCertificate)
	target.searchParams.set(
		"sslrootcert",
		resolve(sourceRoot, sourceCertificate),
	);
process.env.DATABASE_URL = target.toString();
const directory = resolve(outputPath);
await mkdir(directory, { mode: 0o700 });
const save = (name: string, value: unknown) =>
	writeFile(join(directory, name), JSON.stringify(value, null, 2), {
		mode: 0o600,
	});
async function command(argv: string[], input?: string) {
	const result = await runEvaluatorCommand(argv, {
		cwd: process.cwd(),
		timeoutMs: 120000,
		input,
	});
	if (result.code)
		throw new Error(
			`Operator command failed: ${argv[0]} ${argv[1] ?? ""}; ${result.stderr.slice(-1200)}`,
		);
	return result.stdout.trim();
}
const runId = randomUUID();
const container = `ytimesy-evaluation-db-${runId}`;
const localSecret = randomBytes(32).toString("hex");
const password = randomBytes(32).toString("hex");
const frozenRevision = await command(["git", "rev-parse", "HEAD"]);
const taskCommit = await command(["git", "rev-parse", "98c1812^{commit}"]);
if (await command(["git", "status", "--porcelain"]))
	throw new Error("Commit evaluator changes before freezing a live run.");
const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
let local: Pool | undefined;
let worker: ChildProcess | undefined;
let templateVmId: string | undefined;
let snapshotId: string | undefined;
let containerCreated = false;
let creationAttempted = false;
const knownSessionSlugs = new Set<string>();
const ownedSnapshots = new Set<string>();
let sessionWatcher: ReturnType<typeof setInterval> | undefined;
let watcherPending: Promise<void> | undefined;
const cleanupErrors: string[] = [];
let failure: unknown;
const log = await open(join(directory, "worker.log"), "wx", 0o600);
try {
	await command(["docker", "image", "inspect", "postgres:13"]);
	const gradingImage =
		"node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f";
	await command(["docker", "image", "inspect", gradingImage]);
	const owner = await database().query("select id from auth_user where id=$1", [
		userId,
	]);
	const account = await database().query(
		"select encrypted_codex_auth,plan_type from agent_account where user_id=$1 and provider='codex' and status='connected'",
		[userId],
	);
	const sourceProject = await database().query(
		`select p.* from project p where p.user_id=$1 and p.full_name='y-times-y/ytimesy' and p.id='c3e47f8b-588f-48da-83dc-44fa89e93788'`,
		[userId],
	);
	if (
		owner.rows.length !== 1 ||
		account.rows.length !== 1 ||
		sourceProject.rows.length !== 1
	)
		throw new Error(
			"Source owner/account/prepared project is ambiguous or missing.",
		);
	const auth = JSON.parse(await unseal(account.rows[0].encrypted_codex_auth));
	if (codexAccessTokenExpiresAt(auth) < Date.now() + 45 * 60 * 1000)
		throw new Error(
			"Access credential needs at least 45 minutes remaining; no refresh rotation is attempted by this proof.",
		);
	// Never clone a live rotating refresh credential into a second database.
	auth.tokens.refresh_token = "unavailable-in-isolated-evaluation";
	const encryptedAuth = await symmetricEncrypt({
		key: localSecret,
		data: JSON.stringify(auth),
	});
	await closeDatabase();
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
		`ytimesy.evaluation=${runId}`,
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
	containerCreated = true;
	const binding = await command(["docker", "port", container, "5432/tcp"]);
	if (!/^127\.0\.0\.1:\d+$/.test(binding))
		throw new Error("Evaluation database must bind loopback only.");
	const localUrl = new URL(
		`postgresql://postgres:${password}@${binding}/postgres`,
	);
	localUrl.searchParams.set("sslmode", "verify-full");
	localUrl.searchParams.set("sslrootcert", join(directory, "server.crt"));
	local = new Pool({ connectionString: localUrl.toString(), max: 4 });
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
	if (!ready) throw new Error("Local PostgreSQL did not become ready.");
	await local.query("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations"))
		.filter((name) => name.endsWith(".sql"))
		.sort())
		await local.query(await readFile(`supabase/migrations/${file}`, "utf8"));
	await local.query(
		`insert into auth_user(id,name,email,"emailVerified") values($1,'Evaluation operator',$2,true)`,
		[userId, `${runId}@evaluation.invalid`],
	);
	await local.query(
		"insert into agent_account(user_id,provider,status,encrypted_codex_auth,plan_type) values($1,'codex','connected',$2,$3)",
		[userId, encryptedAuth, account.rows[0].plan_type],
	);
	const projectId = randomUUID();
	const workspaceId = randomUUID();
	await local.query(
		"insert into project(id,user_id,repository_id,installation_id,full_name,branch) values($1,$2,$3,$4,'y-times-y/ytimesy','evaluation-frozen')",
		[
			projectId,
			userId,
			sourceProject.rows[0].repository_id,
			sourceProject.rows[0].installation_id,
		],
	);
	const taskRef = `refs/heads/codex/evaluation-task-${runId}`;
	await command(["git", "update-ref", taskRef, taskCommit, "0".repeat(40)]);
	try {
		await command([
			"git",
			"bundle",
			"create",
			join(directory, "baseline.bundle"),
			taskRef,
		]);
	} finally {
		await command(["git", "update-ref", "-d", taskRef, taskCommit]);
	}
	await chmod(join(directory, "baseline.bundle"), 0o600);
	const templateSlug = `ytimesy-isolated-eval-${runId}`;
	await save("resources.json", {
		runId,
		container,
		templateSlug,
		frozenRevision,
		declaredApprovalUsd: cap,
	});
	creationAttempted = true;
	const created = await freestyle.vms.create({
		firewall: GUEST_INTERNET_FIREWALL,
		slug: templateSlug,
		snapshotId: "freestyle/ubuntu-sm",
		metadata: {
			purpose: "ytimesy-isolated-evaluation-template",
			evaluation_id: runId,
		},
		ttlSeconds: 3600,
		maxRunSeconds: 600,
		maxRunTotalSeconds: 600,
		automaticRestart: false,
		autoDeleteSeconds: 3600,
		idleTimeoutSeconds: 120,
	});
	templateVmId = created.vmId;
	await save("resources.json", {
		runId,
		container,
		templateSlug,
		frozenRevision,
		templateVmId,
		declaredApprovalUsd: cap,
	});
	for (let attempt = 0; attempt < 60; attempt++) {
		if ((await created.vm.data()).state === "running") break;
		await new Promise((done) => setTimeout(done, 1000));
	}
	await created.vm.resize({ cpu: 4, memory: 16384, storage: 32768 });
	const resources = (await created.vm.data()).resources;
	if (
		resources.cpu > 4 ||
		resources.memory > 16384 ||
		resources.storage > 32768
	)
		throw new Error("Template exceeds the approved resource shape.");
	await created.vm.fs.writeFile(
		"/home/ubuntu/evaluation.bundle",
		await openAsBlob(join(directory, "baseline.bundle")),
	);
	const prepared = await created.vm.exec({
		command: posixShellCommand([
			"bash",
			"-lc",
			`set -eu
git clone --branch '${taskRef.replace("refs/heads/", "")}' /home/ubuntu/evaluation.bundle /home/ubuntu/ytimesy
cd /home/ubuntu/ytimesy
git checkout -B evaluation-frozen '${taskCommit}'
test "$(git rev-parse HEAD)" = '${taskCommit}'
test ! -e scripts/evaluate-isolated-harness.ts
test -z "$(git status --porcelain)"
git remote set-url origin https://github.com/y-times-y/ytimesy.git
git config user.name 'Evaluation fixture'
git config user.email 'evaluation@ytimesy.invalid'
export HOME=/home/ubuntu
export PATH="$HOME/.local/bin:$HOME/.codex/packages/standalone/current:$HOME/.codex/bin:$PATH"
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin"
corepack prepare pnpm@10.20.0 --activate
pnpm install --frozen-lockfile
${pinnedCodexInstallCommand()}
mkdir -p .ytimesy
`,
		]),
		timeoutMs: 300000,
	});
	if (prepared.statusCode !== 0)
		throw new Error(
			`Frozen template preparation failed: ${prepared.stderr?.slice(-1000)}`,
		);
	await created.vm.fs.writeTextFile(
		"/tmp/ytimesy-project-cwd",
		"/home/ubuntu/ytimesy\n",
	);
	await created.vm.fs.writeTextFile(
		"/home/ubuntu/ytimesy/.ytimesy/environment.json",
		JSON.stringify({
			checks: [
				"$HOME/.local/bin/pnpm exec vitest run src/domain/listed-model.test.ts --maxWorkers=1",
			],
		}),
	);
	const snapshot = await created.vm.snapshot({
		slug: `ytimesy-eval-snapshot-${runId}`,
		autoDeleteSeconds: 3600,
	});
	snapshotId = snapshot.snapshotId;
	if (snapshot.snapshot.public)
		throw new Error("Evaluation snapshot must be private.");
	await created.vm.pause();
	await save("resources.json", {
		runId,
		container,
		templateSlug,
		frozenRevision,
		templateVmId,
		snapshotId,
		declaredApprovalUsd: cap,
		resources,
	});
	await local.query(
		"insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id,template_source_ref,template_source_sha) values($1,$2,$3,'ready',$4,$5,'evaluation-frozen',$6)",
		[workspaceId, userId, projectId, templateVmId, snapshotId, taskCommit],
	);
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		NODE_ENV: "production",
		APP_URL: "http://localhost:3000",
		BETTER_AUTH_SECRET: localSecret,
		DATABASE_URL: localUrl.toString(),
		FREESTYLE_API_KEY: process.env.FREESTYLE_API_KEY ?? "",
		GITHUB_OAUTH_CLIENT_ID: "evaluation-disabled",
		GITHUB_OAUTH_CLIENT_SECRET: "evaluation-disabled",
		GITHUB_APP_CLIENT_ID: "evaluation-disabled",
		GITHUB_APP_CLIENT_SECRET: "evaluation-disabled",
		GITHUB_APP_SLUG: "evaluation-disabled",
		YTIMESY_HARNESS_EVALUATION_ENABLED: "1",
		YTIMESY_EVALUATION_APPROVED: "codex-subscription",
		YTIMESY_INFRASTRUCTURE_ADMISSION: "true",
		YTIMESY_USER_MONTHLY_MICRO_USD: String(Math.floor((cap - 0.5) * 1000000)),
		YTIMESY_FLEET_MONTHLY_MICRO_USD: String(Math.floor((cap - 0.5) * 1000000)),
		YTIMESY_FLEET_LIFETIME_MICRO_USD: String(Math.floor((cap - 0.5) * 1000000)),
		YTIMESY_ENVIRONMENT_AUTO_REFRESH: "false",
		YTIMESY_WORKSPACE_RETENTION: "false",
		YTIMESY_MODEL_WORKFLOWS: "false",
		YTIMESY_MODEL_EXECUTOR_ENABLED: "false",
		YTIMESY_MODEL_CONCURRENCY: "3",
		YTIMESY_USER_TURN_CONCURRENCY: "3",
		YTIMESY_FLEET_TURN_CONCURRENCY: "3",
	};
	await writeFile(
		join(directory, "worker.env"),
		Object.entries(env)
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join("\n"),
		{ mode: 0o600 },
	);
	for (const key of Object.keys(process.env))
		if (
			/^(SUPABASE_|YTIMESY_REALTIME_|YTIMESY_MODEL_|GITHUB_PRIVATE_KEY|OPENAI_|ANTHROPIC_)/.test(
				key,
			)
		)
			delete process.env[key];
	Object.assign(process.env, env);
	worker = spawn(
		process.execPath,
		["--import", "tsx", "src/server/jobs/worker.ts"],
		{ cwd: process.cwd(), env, stdio: ["ignore", log.fd, log.fd] },
	);
	await new Promise((done) => setTimeout(done, 3000));
	const captureSessions = async () => {
		const sessions = await local?.query("select id from agent_session");
		for (const row of sessions?.rows ?? [])
			knownSessionSlugs.add(
				`ytimesy-ag-${String(row.id).replaceAll("-", "").slice(0, 16)}`,
			);
		await save("session-slugs.json", [...knownSessionSlugs]);
	};
	sessionWatcher = setInterval(() => {
		if (!watcherPending)
			watcherPending = captureSessions()
				.catch(() => {
					cleanupErrors.push("Session ownership watcher failed.");
				})
				.finally(() => {
					watcherPending = undefined;
				});
	}, 1000);
	if (worker.exitCode !== null)
		throw new Error("Isolated worker exited during startup.");
	const verifierSource = `const fs = require('node:fs'); const assert = require('node:assert/strict'); const ts = require('typescript');
const source = fs.readFileSync('/workspace/src/domain/listed-model.ts','utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exported = {}; new Function('exports','require',output)(exported,require);
const variants = exported.listedVariantIds;
assert.deepEqual(variants([' fast ', 'fast', '', '  ', ' medium ', null, 4, 'medium', 'FAST']), ['fast','medium','FAST']);
assert.deepEqual(variants({' low ': {}, low: {}, ' ': {}, ' high ': {}, high: {}}), ['low','high']);
for (const bad of [null,undefined,5,true,()=>{}]) assert.deepEqual(variants(bad), []);
let cases=7; const names=['low','medium','high','xhigh','fast'];
for(let i=0;i<64;i++){const expected=names.filter((_,n)=>(i & (1<<n))!==0); const input=expected.flatMap(x=>[' '+x+' ',x,x]); input.splice(1,0,null,' ',0); assert.deepEqual(variants(input),expected); cases++;}
assert.equal(exported.listedModelSupportsFastMode({variants:[' fast ']}),true); cases++;
assert.equal(exported.listedFastModeId({variants:[' fast ', 'fast']}),'fast'); cases++;
const reasoning=exported.listedReasoningFromVariants([' medium ', 'medium', ' high ', ' fast ']);
assert.deepEqual(reasoning.levels.map(x=>x.id),['medium','high']); assert.equal(reasoning.defaultLevelId,'medium'); cases+=2;
console.log(JSON.stringify({passed:true,assertions:cases}));`;
	const bundledVerifier = await build({
		stdin: {
			contents: verifierSource,
			resolveDir: process.cwd(),
			sourcefile: "protected-verifier.cjs",
			loader: "js",
		},
		bundle: true,
		write: false,
		platform: "node",
		format: "cjs",
		target: "node22",
	});
	const verifierPath = join(directory, "verifier.cjs");
	await writeFile(verifierPath, bundledVerifier.outputFiles[0].text, {
		mode: 0o600,
	});
	const protocol = {
		version: 1,
		phase: "development",
		baseline: frozenRevision,
		modelId: "gpt-6.1-sol",
		reasoning: "medium",
		seed: 0,
		repetitions: 2,
		graderImage: gradingImage,
		limits: { durationSeconds: 300, modelRequests: 40, tokens: 400000 },
		tasks: [
			{
				id: "normalize-model-variants",
				benchmark: "development-repository-pilot",
				datasetRevision: taskCommit,
				projectId,
				repository: "y-times-y/ytimesy",
				branch: "evaluation-frozen",
				commit: taskCommit,
				prompt:
					"Improve provider variant normalization. Find the helper used to turn provider variant arrays or objects into IDs. Trim whitespace from every ID, omit empty IDs and non-string array entries, and deduplicate after trimming while preserving first-seen order and case. Both array values and object keys must use these rules. Existing callers such as Fast-mode detection and reasoning-level extraction must benefit from the normalized IDs without caller-specific workarounds. Keep unrelated model selection behavior unchanged. Add regression tests and run the focused listed-model tests. Change only src/domain/listed-model.ts and src/domain/listed-model.test.ts. Do not publish or push anything.",
				allowedPaths: [
					"src/domain/listed-model.ts",
					"src/domain/listed-model.test.ts",
				],
				verifier: {
					command: [verifierPath, "node"],
					sha256: createHash("sha256")
						.update(bundledVerifier.outputFiles[0].contents)
						.digest("hex"),
				},
			},
		],
	};
	await save("protocol.json", protocol);
	const original = `${await command([
		"git",
		"show",
		`${taskCommit}:src/domain/listed-model.ts`,
	])}\n`;
	const sourceFile = ts.createSourceFile(
		"listed-model.ts",
		original,
		ts.ScriptTarget.Latest,
		true,
	);
	const helper = sourceFile.statements.find(
		(node) =>
			ts.isFunctionDeclaration(node) && node.name?.text === "listedVariantIds",
	);
	if (!helper) throw new Error("Frozen task helper is unavailable.");
	const referenceSource =
		original.slice(0, helper.getStart(sourceFile)) +
		`export function listedVariantIds(variants: unknown): readonly string[] {
const values = Array.isArray(variants) ? variants : typeof variants === 'object' && variants !== null ? Object.keys(variants) : [];
return [...new Set(values.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
}` +
		original.slice(helper.end);
	const referencePatch = createTwoFilesPatch(
		"a/src/domain/listed-model.ts",
		"b/src/domain/listed-model.ts",
		original,
		referenceSource,
	);
	const graderInput = {
		repositoryPath: process.cwd(),
		task: protocol.tasks[0],
		image: gradingImage,
		timeoutMs: 120000,
	};
	const negativeGrade = await gradeEvaluationPatches({
		...graderInput,
		patches: [],
	});
	const positiveGrade = await gradeEvaluationPatches({
		...graderInput,
		patches: [referencePatch],
	});
	await save("grader-preflight.json", {
		baseline: negativeGrade,
		reference: positiveGrade,
	});
	if (negativeGrade.passed || !positiveGrade.passed)
		throw new Error(
			"Protected grader controls did not behave as expected; no inference started.",
		);
	console.info(
		JSON.stringify({
			status: "isolated-worker-ready",
			frozenRevision,
			independentTasks: 1,
			armAttempts: 4,
			durationSeconds: 300,
			computeAdmissionUsd: cap - 0.5,
		}),
	);
	const result = await runPairedEvaluation({
		protocolPath: join(directory, "protocol.json"),
		repositoryPath: process.cwd(),
		outputPath: join(directory, "results"),
		userId,
		signal: AbortSignal.timeout(30 * 60 * 1000),
		onSnapshotCreated: async (id) => {
			ownedSnapshots.add(id);
			await save("owned-pair-snapshots.json", [...ownedSnapshots]);
		},
	});
	await save("summary.json", result);
	console.info(JSON.stringify({ status: "pilot-finished", result }));
} catch (error) {
	failure = error;
	await save("failure.json", {
		name: error instanceof Error ? error.name : "unknown",
		message: error instanceof Error ? error.message : "unknown",
	});
} finally {
	if (sessionWatcher) clearInterval(sessionWatcher);
	await watcherPending;
	if (local) {
		try {
			const sessions = await local.query("select id from agent_session");
			for (const row of sessions.rows)
				knownSessionSlugs.add(
					`ytimesy-ag-${String(row.id).replaceAll("-", "").slice(0, 16)}`,
				);
			await save("remaining-session-slugs.json", [...knownSessionSlugs]);
		} catch {
			cleanupErrors.push("Could not capture remaining session identities.");
		}
	}
	await closeJobQueueForTests().catch(() =>
		cleanupErrors.push("Operator queue cleanup failed."),
	);
	await closeDatabase().catch(() =>
		cleanupErrors.push("Operator database cleanup failed."),
	);
	if (worker && worker.exitCode === null) {
		worker.kill("SIGTERM");
		for (let attempt = 0; attempt < 30 && worker.exitCode === null; attempt++)
			await new Promise((done) => setTimeout(done, 1000));
		if (worker.exitCode === null) {
			worker.kill("SIGKILL");
			cleanupErrors.push("Worker required forced termination.");
		}
	}
	for (const slug of knownSessionSlugs) {
		try {
			const found = await freestyle.vms.list({ slug, limit: 2 });
			if (found.vms.length > 1)
				cleanupErrors.push(`Ambiguous VM identity: ${slug}`);
			else
				for (const vm of found.vms)
					if (vm.slug === slug && vm.metadata?.purpose === "ytimesy-workspace")
						await freestyle.vms.ref(vm.id).delete();
					else cleanupErrors.push(`Unexpected VM identity: ${slug}`);
		} catch {
			cleanupErrors.push(`Session cleanup failed: ${slug}`);
		}
		try {
			if ((await freestyle.vms.list({ slug, limit: 2 })).vms.length)
				cleanupErrors.push(`Session VM absence not confirmed: ${slug}`);
		} catch {
			cleanupErrors.push(`Session VM absence query failed: ${slug}`);
		}
	}
	for (const id of ownedSnapshots) {
		try {
			await freestyle.vms.snapshots.delete(id);
		} catch (error) {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				cleanupErrors.push("Pair snapshot cleanup failed.");
		}
	}
	if (snapshotId) {
		try {
			await freestyle.vms.snapshots.delete(snapshotId);
		} catch {
			cleanupErrors.push("Owned snapshot cleanup failed.");
		}
	}
	if (templateVmId) {
		try {
			const vm = freestyle.vms.ref(templateVmId);
			const data = await vm.data();
			if (data.metadata?.evaluation_id !== runId)
				cleanupErrors.push("Wrong template identity.");
			else await vm.delete();
		} catch (error) {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				cleanupErrors.push("Owned template cleanup failed.");
		}
	} else if (creationAttempted)
		cleanupErrors.push(
			"Template creation outcome is unknown; reconcile by recorded slug.",
		);
	await local
		?.end()
		.catch(() => cleanupErrors.push("Local pool cleanup failed."));
	if (containerCreated) {
		try {
			const label = await command([
				"docker",
				"inspect",
				"--format",
				'{{index .Config.Labels "ytimesy.evaluation"}}',
				container,
			]);
			if (label !== runId) cleanupErrors.push("Wrong container identity.");
			else await command(["docker", "rm", "--force", "--volumes", container]);
		} catch {
			cleanupErrors.push("Owned database container cleanup failed.");
		}
	}
	await log.close();
	if (templateVmId) {
		try {
			await freestyle.vms.ref(templateVmId).data();
			cleanupErrors.push("Template VM still exists.");
		} catch (error) {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				cleanupErrors.push("Template absence query failed.");
		}
	}
	for (const id of [snapshotId, ...ownedSnapshots].filter(
		(value): value is string => Boolean(value),
	)) {
		try {
			await freestyle.vms.snapshots.get(id);
			cleanupErrors.push("Owned snapshot still exists.");
		} catch (error) {
			if (!(error instanceof FreestyleApiError && error.status === 404))
				cleanupErrors.push("Snapshot absence query failed.");
		}
	}
	await save("cleanup.json", {
		cleanupErrors,
		sharedDevelopmentDatabaseMutated: false,
		sharedWorkerReplaced: false,
	});
}
if (failure || cleanupErrors.length)
	throw new AggregateError(
		[
			...(failure ? [failure] : []),
			...cleanupErrors.map((message) => new Error(message)),
		],
		"Isolated evaluation or cleanup failed; inspect private evidence.",
	);
