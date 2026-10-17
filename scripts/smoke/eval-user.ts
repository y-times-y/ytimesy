// Throwaway development users for eval runs, so evals can run side by side.
//
// Every eval script used to run as the single dev owner and mutate per-user
// state (memory mode and repo, projects), so two runs clashed. A run now gets
// its own auth_user with the minimum rows a user needs to own projects,
// sessions and VMs, and deletes all of it on exit. See docs/parallel-evals.md.
//
//   node --env-file=.env --import tsx scripts/smoke/eval-user.ts --cleanup [--older-than 6]
//       Removes users left by crashed or killed runs: every local manifest
//       whose process is gone, and eval users older than --older-than hours.
//   node --env-file=.env --import tsx scripts/smoke/eval-user.ts --list
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Freestyle } from "freestyle";
import {
	DEFAULT_HARNESS_VARIANT,
	type HarnessVariant,
	harnessVariantChanges,
	harnessVariantLabel,
} from "../../src/domain/harness-variant";
import type { MemoryMode } from "../../src/domain/memory-repo";
import {
	accountCleanupTargets,
	deleteAccountRecords,
} from "../../src/server/adapters/account-deletion";
import {
	checkpointStorageConfigured,
	removeChatObjects,
} from "../../src/server/adapters/checkpoints/storage";
import { closeDatabase, database } from "../../src/server/adapters/database";
import { memoryRepoName } from "../../src/server/adapters/memory-repos";
import { seal, unseal } from "../../src/server/auth/token-vault";
import { cancelServerTurn } from "../../src/server/services/cancel-server-turn";

const run = promisify(execFile);
const DEV_REF = "exampledevprojectref";
const MEMORY_NAMESPACE = "ytimesy-memory-development";
const MANIFESTS = ".ytimesy/eval-users";
const EMAIL_DOMAIN = "ytimesy-eval.invalid";

export type EvalProject = {
	projectId: string;
	workspaceId: string;
	/** owner/name of the source repository; the fixture directory is `name`. */
	fullName: string;
	dirName: string;
};

export type EvalUser = {
	userId: string;
	/** The Codex subscription owner whose login and connections are borrowed. */
	ownerId: string;
	/** True when the run uses the owner directly (--as-owner): no isolation. */
	asOwner: boolean;
	variant: HarnessVariant;
	project: EvalProject;
	/** The user's OpenRouter connection (a copy of the owner's), if any. */
	openRouterConnectionId: string | null;
	/** The user's memory repo name (user_memory.repo). */
	memoryRepo: string;
	/** Sets this user's memory mode and repo (the repo is deleted on release). */
	setMemory(mode: MemoryMode, repo?: string | null): Promise<void>;
	/** Records a VM so a crashed run's --cleanup can delete it. */
	trackVm(vmId: string): Promise<void>;
	/** Deletes everything this run created; returns what could not be removed. */
	release(): Promise<string[]>;
};

type Manifest = {
	userId: string;
	ownerId: string;
	label: string;
	pid: number;
	host: string;
	createdAt: string;
	vms: string[];
	memoryRepos: string[];
	asOwner?: boolean;
};

export async function assertDevelopmentDatabase() {
	if (
		(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== DEV_REF ||
		!new URL(process.env.DATABASE_URL ?? "").username.includes(DEV_REF)
	)
		throw new Error(
			"Refusing to run: DATABASE_URL is not the development project.",
		);
}

/** The one dev user with a connected Codex subscription. */
async function subscriptionOwner() {
	const owners = (
		await database().query<{ user_id: string }>(
			"select a.user_id from agent_account a where a.provider='codex' and a.status='connected' and a.encrypted_codex_auth is not null and not exists (select 1 from dev_eval_user e where e.user_id=a.user_id)",
		)
	).rows;
	if (owners.length !== 1)
		throw new Error("Requires one connected subscription owner.");
	return owners[0].user_id;
}

/** The owner's most recently used project: the template for eval projects. */
async function ownerProject(ownerId: string) {
	const source = (
		await database().query<{
			project_id: string;
			workspace_id: string;
			full_name: string;
		}>(
			"select s.project_id,s.workspace_id,p.full_name from agent_session s join project p on p.id=s.project_id where s.user_id=$1 and s.listed_model_id is not null order by s.updated_at desc limit 1",
			[ownerId],
		)
	).rows[0];
	if (!source) throw new Error("No project is configured for the owner.");
	const dirName = source.full_name.split("/")[1];
	if (!dirName || !/^[a-zA-Z0-9_.-]+$/.test(dirName))
		throw new Error("Invalid fixture directory name.");
	return source;
}

/**
 * Copies the owner's project and workspace rows to `userId`. The copy never
 * points at the owner's VM (provider_ref), so deleting it can't touch it.
 */
async function copyProject(
	ownerId: string,
	userId: string,
): Promise<EvalProject> {
	const source = await ownerProject(ownerId);
	const projectId = randomUUID();
	const workspaceId = randomUUID();
	const db = database();
	await db.query(
		`insert into project select (jsonb_populate_record(null::project,
			to_jsonb(p) || jsonb_build_object('id', $2::uuid, 'user_id', $3::text, 'repository_id', $4::bigint, 'created_at', now()))).*
		 from project p where p.id=$1`,
		[
			source.project_id,
			projectId,
			userId,
			9_000_000_000 + Math.floor(Math.random() * 1e9),
		],
	);
	await db.query(
		`insert into workspace select (jsonb_populate_record(null::workspace,
			to_jsonb(w) || jsonb_build_object('id', $2::uuid, 'project_id', $3::uuid, 'user_id', $4::text,
				'provider_ref', null, 'last_job_id', null, 'created_at', now(), 'updated_at', now()))).*
		 from workspace w where w.id=$1`,
		[source.workspace_id, workspaceId, projectId, userId],
	);
	return {
		projectId,
		workspaceId,
		fullName: source.full_name,
		dirName: source.full_name.split("/")[1],
	};
}

/**
 * A structurally valid but unusable Codex login: an expired access token
 * and a refresh token the issuer rejects. Turns resolve the owner's real
 * login instead (dev_eval_user, YTIMESY_DEV_EVAL_USERS=1); if that switch is
 * ever off, the refresh fails on this row and the owner's login is untouched.
 */
function placeholderCodexAuth(): string {
	const part = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return JSON.stringify({
		auth_mode: "chatgpt",
		tokens: {
			access_token: `${part({ alg: "none" })}.${part({ exp: 0 })}.eval`,
			refresh_token: "eval-user-delegates-to-owner",
			account_id: "eval-user-delegates-to-owner",
		},
	});
}

/** Copies the owner's OpenRouter connections, re-sealed for the new user. */
async function copyOpenRouterConnections(ownerId: string, userId: string) {
	const db = database();
	const rows = (
		await db.query<{
			id: string;
			label: string;
			base_url: string;
			sealed_credential: string;
			models: unknown;
			last_probe_at: Date | null;
		}>(
			"select id,label,base_url,sealed_credential,models,last_probe_at from model_connection where user_id=$1 and provider='openrouter' order by created_at",
			[ownerId],
		)
	).rows;
	const ids: string[] = [];
	for (const row of rows) {
		const credential = JSON.parse(await unseal(row.sealed_credential)) as {
			id: string;
			userId: string;
			apiKey: string;
		};
		if (credential.id !== row.id || credential.userId !== ownerId)
			throw new Error("Owner connection credential ownership mismatch.");
		const id = randomUUID();
		// The same key, bound to the copy's id and user like a saved connection.
		await db.query(
			`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,models,revision,last_probe_at)
			 values($1,$2,'openrouter',$3,$4,$5,$6::jsonb,$7,$8)`,
			[
				id,
				userId,
				row.label,
				row.base_url,
				await seal(JSON.stringify({ ...credential, id, userId })),
				JSON.stringify(row.models),
				randomUUID(),
				row.last_probe_at,
			],
		);
		ids.push(id);
	}
	return ids;
}

function manifestPath(userId: string) {
	return join(MANIFESTS, `${userId}.json`);
}

async function writeManifest(manifest: Manifest) {
	await mkdir(MANIFESTS, { recursive: true });
	await writeFile(
		manifestPath(manifest.userId),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

async function deleteMemoryRepo(name: string) {
	try {
		await run(
			"pnpm",
			[
				"exec",
				"wrangler",
				"artifacts",
				"repos",
				"delete",
				name,
				"--namespace",
				MEMORY_NAMESPACE,
				"-y",
			],
			{ timeout: 60_000 },
		);
		return null;
	} catch (error) {
		const text = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
		// A repo that was never created (memory stayed off) is already gone.
		if (/not.?found|does not exist|404/i.test(text)) return null;
		return (
			text
				// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colours
				.replaceAll(/\u001b\[[0-9;]*m/g, "")
				.split("\n")
				.find((line) => /error|✘/i.test(line))
				?.trim()
				.slice(0, 160) ?? String(error).slice(0, 160)
		);
	}
}

/**
 * Deletes an eval user and everything it owns: live turns are cancelled,
 * chat files removed, rows deleted (they cascade from auth_user), then its
 * VMs and memory repos. Shared snapshots are never touched.
 */
async function releaseUser(manifest: Manifest): Promise<string[]> {
	const { userId } = manifest;
	const db = database();
	const leftovers: string[] = [];
	const isEval = (
		await db.query("select 1 from dev_eval_user where user_id=$1", [userId])
	).rowCount;
	const targets = isEval
		? await accountCleanupTargets(userId)
		: { vmIds: [], sessionIds: [], memoryRepo: null };
	if (isEval) {
		const active = (
			await db.query<{ session_id: string }>(
				"select distinct session_id from api_turn where user_id=$1 and state in ('queued','running')",
				[userId],
			)
		).rows;
		for (const { session_id } of active)
			await cancelServerTurn(userId, session_id).catch(() => {});
		if (checkpointStorageConfigured())
			for (const sessionId of targets.sessionIds)
				await removeChatObjects(userId, sessionId).catch(() => {
					leftovers.push(`chat-files:${sessionId}`);
				});
		await deleteAccountRecords(userId).catch((error) => {
			leftovers.push(`user:${userId} (${String(error).slice(0, 120)})`);
		});
	}
	const apiKey = process.env.FREESTYLE_API_KEY;
	const vms = [...new Set([...manifest.vms, ...targets.vmIds])];
	if (vms.length) {
		if (!apiKey) leftovers.push(...vms.map((id) => `vm:${id}`));
		else {
			const client = new Freestyle({ apiKey });
			for (const id of vms)
				await client.vms.delete(id).catch((error: unknown) => {
					if (!/not.?found|404/i.test(String(error)))
						leftovers.push(`vm:${id}`);
				});
		}
	}
	// A live run's manifest lists every repo it turned memory on for; a user
	// found only in the database (pid 0) may have used its override or default.
	const repos = new Set(
		[
			...manifest.memoryRepos,
			...(manifest.pid === 0
				? [targets.memoryRepo, memoryRepoName(userId)]
				: []),
		].filter((name): name is string => Boolean(name)),
	);
	// Only repos this run could have created: never the owner's own.
	for (const name of repos) {
		if (name === memoryRepoName(manifest.ownerId)) continue;
		const failure = await deleteMemoryRepo(name);
		if (failure) leftovers.push(`memory-repo:${name} (${failure})`);
	}
	if (!leftovers.length)
		await rm(manifestPath(userId), { force: true }).catch(() => {});
	return leftovers;
}

// ---------------------------------------------------------------------------
// Process lifecycle: graceful stop on the first signal, forced cleanup on the
// second, after a grace period, or on a crash.

const live = new Map<string, EvalUser>();
const stopCallbacks = new Set<() => void>();
let installed = false;
let releasing: Promise<void> | null = null;
const STOP_GRACE_MS = 10 * 60_000;

async function releaseAll(reason: string) {
	releasing ??= (async () => {
		const users = [...live.values()];
		if (users.length)
			console.error(
				`${reason}: deleting ${users.length} eval user(s); run --cleanup if this is interrupted.`,
			);
		for (const user of users) {
			const leftovers = await user.release().catch((error) => [String(error)]);
			if (leftovers.length)
				console.error(`Cleanup incomplete: ${leftovers.join(", ")}.`);
		}
	})();
	return releasing;
}

function installHandlers() {
	if (installed) return;
	installed = true;
	let signals = 0;
	const onSignal = (signal: NodeJS.Signals) => {
		signals++;
		if (signals === 1) {
			console.error(
				`${signal}: stopping runs and cleaning up (send again to force).`,
			);
			for (const callback of stopCallbacks) callback();
			setTimeout(() => {
				void releaseAll("Stop grace period ended").finally(() =>
					process.exit(130),
				);
			}, STOP_GRACE_MS).unref();
			return;
		}
		void releaseAll(`${signal} again`).finally(() => process.exit(130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const crash = (error: unknown) => {
		console.error(error);
		void releaseAll("Crash").finally(() => process.exit(1));
	};
	process.on("uncaughtException", crash);
	process.on("unhandledRejection", crash);
}

/** Called on the first SIGINT/SIGTERM; scripts stop starting new work. */
export function onEvalStop(callback: () => void) {
	installHandlers();
	stopCallbacks.add(callback);
}

/**
 * A throwaway dev user for one eval run (or the owner with `asOwner`).
 * Codex subscription turns borrow the owner's login (resolved per request on
 * the owner's row); OpenRouter connections are copies of the owner's key.
 */
export async function createEvalUser(options: {
	label: string;
	variant?: HarnessVariant;
	/** Run as the owner (no isolation; the variant must be the default). */
	asOwner?: boolean;
	/** Copy the owner's OpenRouter connection(s). */
	openRouter?: boolean;
	/** Initial memory mode for the user (default off: no hooks, no repo). */
	memory?: MemoryMode;
	/** Leave memory repos behind on release (inspection; delete them yourself). */
	keepRepos?: boolean;
}): Promise<EvalUser> {
	await assertDevelopmentDatabase();
	installHandlers();
	// Local services (catalog checks, sends) resolve the owner's login too.
	process.env.YTIMESY_DEV_EVAL_USERS = "1";
	const variant = options.variant ?? DEFAULT_HARNESS_VARIANT;
	const ownerId = await subscriptionOwner();
	const db = database();
	if (options.asOwner) {
		if (harnessVariantLabel(variant) !== "default")
			throw new Error("Harness variants need an eval user, not --as-owner.");
		const source = await ownerProject(ownerId);
		const gateways = (
			await db.query<{ id: string }>(
				"select id from model_connection where user_id=$1 and provider='openrouter'",
				[ownerId],
			)
		).rows;
		return {
			userId: ownerId,
			ownerId,
			asOwner: true,
			variant,
			project: {
				projectId: source.project_id,
				workspaceId: source.workspace_id,
				fullName: source.full_name,
				dirName: source.full_name.split("/")[1],
			},
			openRouterConnectionId: gateways.length === 1 ? gateways[0].id : null,
			memoryRepo: memoryRepoName(ownerId),
			setMemory: async () => {
				throw new Error("Memory settings need an eval user, not --as-owner.");
			},
			trackVm: async () => {},
			release: async () => [],
		};
	}
	const short = randomUUID().replaceAll("-", "").slice(0, 12);
	const userId = `eval-${short}`;
	const label = options.label.replaceAll(/[^\w.:=,-]/g, "-").slice(0, 80);
	const manifest: Manifest = {
		userId,
		ownerId,
		label,
		pid: process.pid,
		host: hostname(),
		createdAt: new Date().toISOString(),
		vms: [],
		memoryRepos: [],
	};
	// The manifest exists before any row, so a crash at any point is cleanable.
	await writeManifest(manifest);
	let released: Promise<string[]> | null = null;
	const user: EvalUser = {
		userId,
		ownerId,
		asOwner: false,
		variant,
		project: { projectId: "", workspaceId: "", fullName: "", dirName: "" },
		openRouterConnectionId: null,
		memoryRepo: memoryRepoName(userId),
		async setMemory(mode, repo) {
			const name = repo ?? user.memoryRepo;
			if (
				mode !== "off" &&
				!options.keepRepos &&
				!manifest.memoryRepos.includes(name)
			) {
				manifest.memoryRepos.push(name);
				await writeManifest(manifest);
			}
			await db.query(
				`insert into user_memory(user_id,mode,repo,dreamed_through) values($1,$2,$3,now())
				 on conflict(user_id) do update set mode=excluded.mode,repo=excluded.repo,dreamed_through=excluded.dreamed_through,updated_at=now()`,
				[userId, mode, name],
			);
		},
		async trackVm(vmId) {
			manifest.vms.push(vmId);
			await writeManifest(manifest);
		},
		release() {
			released ??= releaseUser(manifest).finally(() => live.delete(userId));
			return released;
		},
	};
	live.set(userId, user);
	try {
		await db.query(
			`insert into auth_user(id,name,email,"emailVerified") values($1,$2,$3,true)`,
			[userId, `Eval ${label}`, `${userId}@${EMAIL_DOMAIN}`],
		);
		await db.query(
			"insert into dev_eval_user(user_id,owner_user_id,label,harness_variant) values($1,$2,$3,$4::jsonb)",
			[userId, ownerId, label, JSON.stringify(harnessVariantChanges(variant))],
		);
		await db.query(
			`insert into agent_account(user_id,provider,status,plan_type,updated_at,encrypted_codex_auth)
			 select $1,'codex','connected',plan_type,now(),$3 from agent_account where user_id=$2 and provider='codex'`,
			[userId, ownerId, await seal(placeholderCodexAuth())],
		);
		// The subscription model list is a cache of the same account's catalog.
		await db.query(
			`insert into agent_model_catalog(user_id,provider,models,updated_at)
			 select $1,provider,models,updated_at from agent_model_catalog where user_id=$2`,
			[userId, ownerId],
		);
		if (options.openRouter) {
			const ids = await copyOpenRouterConnections(ownerId, userId);
			user.openRouterConnectionId = ids.length === 1 ? ids[0] : null;
		}
		await user.setMemory(options.memory ?? "off");
		user.project = await copyProject(ownerId, userId);
	} catch (error) {
		await user.release().catch(() => {});
		throw error;
	}
	return user;
}

// ---------------------------------------------------------------------------
// Cross-process rate-limit slots: at most `limit` holders of `name` across
// every eval process on this machine (e.g. OpenRouter's 20 rpm free tier).

const SLOTS = join(tmpdir(), "ytimesy-eval-slots");

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function withSlot<T>(
	name: string,
	limit: number,
	work: () => Promise<T>,
	shouldStop: () => boolean = () => false,
): Promise<T> {
	await mkdir(SLOTS, { recursive: true });
	const token = `${process.pid}:${randomUUID()}`;
	let held: string | null = null;
	let waitedLogged = false;
	while (!held) {
		for (let index = 0; index < limit && !held; index++) {
			const path = join(SLOTS, `${name}.${index}`);
			try {
				const handle = await open(path, "wx");
				await handle.writeFile(token);
				await handle.close();
				held = path;
			} catch {
				// A slot whose holder died is free again.
				const owner = Number(
					(await readFile(path, "utf8").catch(() => "")).split(":")[0],
				);
				if (owner && owner !== process.pid && !alive(owner))
					await rm(path, { force: true });
			}
		}
		if (held) break;
		if (shouldStop()) throw new Error(`Stopped while waiting for ${name}.`);
		if (!waitedLogged) {
			waitedLogged = true;
			console.info(`Waiting for a ${name} slot (limit ${limit}).`);
		}
		await delay(2000 + Math.random() * 1000);
	}
	try {
		return await work();
	} finally {
		if ((await readFile(held, "utf8").catch(() => "")) === token)
			await rm(held, { force: true });
	}
}

/** Global slot limits, overridable per machine. */
export const SLOT_LIMITS = {
	/** Concurrent Codex subscription turns across all eval processes. */
	codex: Number(process.env.YTIMESY_EVAL_CODEX_SLOTS) || 8,
	/** Concurrent OpenRouter `:free` runs (20 requests/min per account). */
	openRouterFree: Number(process.env.YTIMESY_EVAL_FREE_SLOTS) || 2,
};

// ---------------------------------------------------------------------------
// CLI: --cleanup / --list

async function cli() {
	const { values } = parseArgs({
		options: {
			cleanup: { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			"older-than": { type: "string", default: "6" },
		},
	});
	await assertDevelopmentDatabase();
	const db = database();
	const files = await readdir(MANIFESTS).catch(() => [] as string[]);
	const manifests: Manifest[] = [];
	for (const file of files.filter((name) => name.endsWith(".json")))
		manifests.push(JSON.parse(await readFile(join(MANIFESTS, file), "utf8")));
	const users = (
		await db.query<{
			user_id: string;
			owner_user_id: string;
			label: string;
			created_at: Date;
		}>(
			"select user_id,owner_user_id,label,created_at from dev_eval_user order by created_at",
		)
	).rows;
	if (values.list || !values.cleanup) {
		console.log(
			JSON.stringify(
				{
					manifests: manifests.map((m) => ({
						userId: m.userId,
						label: m.label,
						pid: m.pid,
						running: m.host === hostname() && alive(m.pid),
						vms: m.vms.length,
						memoryRepos: m.memoryRepos,
					})),
					databaseEvalUsers: users,
				},
				null,
				2,
			),
		);
		if (!values.cleanup) return;
	}
	const olderThanMs = Math.max(0, Number(values["older-than"]) || 0) * 3600_000;
	const handled = new Set<string>();
	let failed = 0;
	for (const manifest of manifests) {
		handled.add(manifest.userId);
		if (manifest.host === hostname() && alive(manifest.pid)) {
			console.log(
				`skip ${manifest.userId}: its run (pid ${manifest.pid}) is live`,
			);
			continue;
		}
		const leftovers = await releaseUser(manifest);
		failed += leftovers.length;
		console.log(
			`${manifest.userId} (${manifest.label}): ${leftovers.length ? `left ${leftovers.join(", ")}` : "removed"}`,
		);
	}
	for (const row of users) {
		if (handled.has(row.user_id)) continue;
		if (Date.now() - new Date(row.created_at).getTime() < olderThanMs) {
			console.log(
				`skip ${row.user_id} (${row.label}): no local manifest and younger than --older-than (another machine or worktree may own it)`,
			);
			continue;
		}
		const leftovers = await releaseUser({
			userId: row.user_id,
			ownerId: row.owner_user_id,
			label: row.label,
			pid: 0,
			host: "",
			createdAt: new Date(row.created_at).toISOString(),
			vms: [],
			memoryRepos: [],
		});
		failed += leftovers.length;
		console.log(
			`${row.user_id} (${row.label}): ${leftovers.length ? `left ${leftovers.join(", ")}` : "removed"}`,
		);
	}
	if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
	await cli().finally(() => closeDatabase());
