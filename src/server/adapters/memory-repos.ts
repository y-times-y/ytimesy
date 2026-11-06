import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { MemoryChange, MemoryFiles } from "#/domain/memory-repo";
import { InMemoryFs } from "./memory-fs";

/**
 * Each user's memory is one private Git repo in a Cloudflare Artifacts
 * namespace. Reads go through the Workers binding; writes go through Git
 * with a short-lived repo-scoped token, from the Worker (isomorphic-git) or
 * from the builder's VM (the git CLI).
 */

/** The parts of the Artifacts Workers binding this adapter uses. */
export type ArtifactsNamespace = {
	create(
		name: string,
		opts?: { description?: string; setDefaultBranch?: string },
	): Promise<{ remote: string }>;
	get(name: string): Promise<ArtifactsRepoHandle>;
	delete(name: string): Promise<boolean>;
};
type ArtifactsRepoHandle = {
	[Symbol.dispose]?: () => void;
	info(): Promise<{ remote: string }>;
	createToken(
		scope?: "read" | "write",
		ttl?: number,
	): Promise<{ id?: string; plaintext: string }>;
	revokeToken?(tokenOrId: string): Promise<boolean>;
	log(opts?: { ref?: string; limit?: number }): Promise<ArtifactsCommit[]>;
	readCommit(hash: string): Promise<ArtifactsCommit | null>;
	readTree(
		hash: string,
	): Promise<{ name: string; hash: string; type: string }[] | null>;
	readBlob(hash: string): Promise<Blob | null>;
};
type ArtifactsCommit = {
	hash: string;
	treeHash: string;
	message: string;
	parents: string[];
	committedAt: number;
};

export type MemoryCommit = {
	hash: string;
	message: string;
	/** Epoch milliseconds. */
	committedAt: number;
};
export type MemorySnapshot = { head: string | null; files: MemoryFiles };
export type MemoryCommitOutcome =
	| { ok: true; hash: string | null }
	| { ok: false; reason: "conflict"; current: MemorySnapshot };

/** One user's repo; tests substitute their own. */
export type MemoryRepo = {
	readonly name: string;
	snapshot(): Promise<MemorySnapshot>;
	/** The files at an earlier commit of this repo (empty for a commit it no longer has). */
	snapshotAt(head: string): Promise<MemorySnapshot>;
	/** One commit turning `base` into base + `changes`, pushed; a conflicting concurrent edit is reported, not merged. */
	commit(
		base: MemorySnapshot,
		changes: readonly MemoryChange[],
		message: string,
	): Promise<MemoryCommitOutcome>;
	/**
	 * Remote URL and a write token for a Git client, creating the repo on
	 * first use; `tokenId` names the token for revocation without it.
	 */
	credentials(
		ttlSeconds: number,
	): Promise<{ remote: string; token: string; tokenId?: string }>;
	/** Revokes a token `credentials` returned (or its id), before its TTL runs out. */
	revokeCredential?(tokenOrId: string): Promise<void>;
	/** Commits that changed `path`, newest first, with the file before and after. */
	history(
		path: string,
		limit?: number,
	): Promise<
		(MemoryCommit & { before: string | null; after: string | null })[]
	>;
	/** The newest commits on main, newest first, each with its first parent. */
	log?(limit: number): Promise<(MemoryCommit & { parent: string | null })[]>;
	destroy(): Promise<void>;
};

let namespace: ArtifactsNamespace | undefined;

export function registerMemoryRepos(binding: ArtifactsNamespace | undefined) {
	if (binding) namespace = binding;
}

export function memoryReposAvailable() {
	return Boolean(namespace);
}

/** `memory-<user>` as in the spec's examples; an explicit name overrides it (evaluations). */
export function memoryRepoName(userId: string, override?: string | null) {
	const name = override || `memory-${userId}`;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name))
		throw new Error("Invalid memory repo name.");
	return name;
}

export function memoryRepo(name: string): MemoryRepo | null {
	return namespace ? artifactsMemoryRepo(namespace, name) : null;
}

const MAX_FILE_BYTES = 256 * 1024;
const READ_CONCURRENCY = 8;
/** Per-isolate file snapshots by commit; history never changes. */
const snapshots = new Map<string, MemoryFiles>();
/** The cache holds at most this many characters of file text (about 8 MB), so an isolate shared with other jobs never fills up with old snapshots. */
export const SNAPSHOT_CACHE_CHARS = 8 * 1024 * 1024;
const snapshotSizes = new Map<string, number>();
let snapshotChars = 0;

/** Keeps `files` for repeat reads of the same commit, evicting the oldest past the limits; a snapshot larger than the whole budget is not kept. */
export function rememberSnapshot(key: string, files: MemoryFiles) {
	const size = Object.values(files).reduce((sum, text) => sum + text.length, 0);
	if (size > SNAPSHOT_CACHE_CHARS) return;
	while (
		snapshots.size > 0 &&
		(snapshots.size >= 64 || snapshotChars + size > SNAPSHOT_CACHE_CHARS)
	) {
		const oldest = snapshots.keys().next().value as string;
		snapshots.delete(oldest);
		snapshotChars -= snapshotSizes.get(oldest) ?? 0;
		snapshotSizes.delete(oldest);
	}
	snapshots.set(key, files);
	snapshotSizes.set(key, size);
	snapshotChars += size;
}

/** Test hook: the cache's current size. */
export function snapshotCacheState() {
	return { entries: snapshots.size, chars: snapshotChars };
}

/** Test hook: empties the cache. */
export function clearSnapshotCache() {
	snapshots.clear();
	snapshotSizes.clear();
	snapshotChars = 0;
}

function artifactsMemoryRepo(
	artifacts: ArtifactsNamespace,
	name: string,
	gitHttp: typeof http = http,
): MemoryRepo {
	async function withRepo<T>(
		run: (repo: ArtifactsRepoHandle) => Promise<T>,
	): Promise<T | null> {
		let repo: ArtifactsRepoHandle;
		try {
			repo = await artifacts.get(name);
		} catch (error) {
			if (artifactsCode(error) === "NOT_FOUND") return null;
			throw error;
		}
		try {
			return await run(repo);
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	async function headCommit(repo: ArtifactsRepoHandle) {
		// An empty repo has no main ref yet.
		const [latest] = await repo
			.log({ ref: "main", limit: 1 })
			.catch(() => [] as ArtifactsCommit[]);
		return latest ?? null;
	}

	async function blobs(repo: ArtifactsRepoHandle, treeHash: string) {
		const out: Record<string, string> = {};
		const walk = async (hash: string, prefix: string) => {
			for (const entry of (await repo.readTree(hash)) ?? []) {
				const path = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.type === "tree") await walk(entry.hash, path);
				else if (entry.type === "blob" || entry.type === "exec")
					out[path] = entry.hash;
			}
		};
		await walk(treeHash, "");
		return out;
	}

	async function read(repo: ArtifactsRepoHandle, hash: string) {
		const blob = await repo.readBlob(hash);
		if (!blob || blob.size > MAX_FILE_BYTES) return null;
		return blob.text();
	}

	async function credentials(ttlSeconds: number) {
		const existing = await withRepo(async (repo) => ({
			remote: (await repo.info()).remote,
			...tokenFields(await repo.createToken("write", ttlSeconds)),
		}));
		if (existing) return minted(existing);
		try {
			await artifacts.create(name, {
				description: "Agent Memory Repo",
				setDefaultBranch: "main",
			});
		} catch (error) {
			if (artifactsCode(error) !== "ALREADY_EXISTS") throw error;
		}
		const created = await withRepo(async (repo) => ({
			remote: (await repo.info()).remote,
			...tokenFields(await repo.createToken("write", ttlSeconds)),
		}));
		if (!created) throw new Error("Memory repo could not be created.");
		return minted(created);
	}
	/** Plaintext as Artifacts issued it, by the bare token handed out, for revocation. */
	const issued = new Map<string, string>();
	function minted(credential: {
		remote: string;
		token: string;
		tokenId?: string;
	}) {
		const token = bareToken(credential.token);
		if (issued.size > 64) issued.delete(issued.keys().next().value as string);
		issued.set(token, credential.token);
		return {
			remote: credential.remote,
			token,
			...(credential.tokenId ? { tokenId: credential.tokenId } : {}),
		};
	}

	async function filesAt(repo: ArtifactsRepoHandle, commit: ArtifactsCommit) {
		const key = `${name}:${commit.hash}`;
		const cached = snapshots.get(key);
		if (cached) return cached;
		const files: MemoryFiles = {};
		const entries = Object.entries(await blobs(repo, commit.treeHash));
		for (let start = 0; start < entries.length; start += READ_CONCURRENCY)
			await Promise.all(
				entries
					.slice(start, start + READ_CONCURRENCY)
					.map(async ([path, hash]) => {
						const text = await read(repo, hash);
						if (text !== null) files[path] = text;
					}),
			);
		rememberSnapshot(key, files);
		return files;
	}

	async function snapshot(): Promise<MemorySnapshot> {
		return (
			(await withRepo(async (repo) => {
				const head = await headCommit(repo);
				if (!head) return { head: null, files: {} };
				return { head: head.hash, files: await filesAt(repo, head) };
			})) ?? { head: null, files: {} }
		);
	}

	async function snapshotAt(hash: string): Promise<MemorySnapshot> {
		return (
			(await withRepo(async (repo) => {
				const commit = await repo.readCommit(hash).catch(() => null);
				if (!commit) return { head: hash, files: {} };
				return { head: hash, files: await filesAt(repo, commit) };
			})) ?? { head: hash, files: {} }
		);
	}

	return {
		name,
		snapshot,
		snapshotAt,
		credentials,
		async revokeCredential(token) {
			const plaintext = issued.get(token) ?? token;
			issued.delete(token);
			await withRepo(async (repo) => {
				await repo.revokeToken?.(plaintext);
			});
		},
		async commit(base, changes, message) {
			const effective = changes.filter(
				(change) => (base.files[change.path] ?? null) !== change.content,
			);
			if (!effective.length) return { ok: true, hash: base.head };
			for (let attempt = 0; ; attempt++) {
				const { remote, token } = await credentials(600);
				const outcome = await pushChanges({
					http: gitHttp,
					remote,
					token,
					base,
					changes: effective,
					message,
				});
				if (outcome !== "raced" || attempt >= 2) {
					if (outcome === "raced")
						return { ok: false, reason: "conflict", current: await snapshot() };
					if (outcome.ok) return outcome;
					return { ok: false, reason: "conflict", current: await snapshot() };
				}
			}
		},
		async history(path, limit = 30) {
			return (
				(await withRepo(async (repo) => {
					const commits = await repo
						.log({ ref: "main", limit: Math.min(limit * 3, 200) })
						.catch(() => [] as ArtifactsCommit[]);
					const blobAt = async (commit: ArtifactsCommit | null) => {
						if (!commit) return null;
						let tree = commit.treeHash;
						const parts = path.split("/");
						for (const [index, part] of parts.entries()) {
							const entry = (await repo.readTree(tree))?.find(
								(row) => row.name === part,
							);
							if (!entry) return null;
							if (index === parts.length - 1) return entry.hash;
							tree = entry.hash;
						}
						return null;
					};
					const out: (MemoryCommit & {
						before: string | null;
						after: string | null;
					})[] = [];
					for (const commit of commits) {
						if (out.length >= limit) break;
						const parent = commit.parents[0]
							? await repo.readCommit(commit.parents[0])
							: null;
						const [after, before] = await Promise.all([
							blobAt(commit),
							blobAt(parent),
						]);
						if (after === before) continue;
						out.push({
							hash: commit.hash,
							message: commit.message,
							committedAt: epochMs(commit.committedAt),
							after: after ? await read(repo, after) : null,
							before: before ? await read(repo, before) : null,
						});
					}
					return out;
				})) ?? []
			);
		},
		async log(limit) {
			return (
				(await withRepo(async (repo) =>
					(
						await repo
							.log({ ref: "main", limit: Math.min(Math.max(limit, 1), 200) })
							.catch(() => [] as ArtifactsCommit[])
					).map((commit) => ({
						hash: commit.hash,
						message: commit.message,
						committedAt: epochMs(commit.committedAt),
						parent: commit.parents[0] ?? null,
					})),
				)) ?? []
			);
		},
		async destroy() {
			try {
				await artifacts.delete(name);
			} catch (error) {
				if (artifactsCode(error) !== "NOT_FOUND") throw error;
			}
		},
	};
}

const DIR = "/repo";
const AUTHOR = { name: "ytimesy memory", email: "memory@ytimesy.invalid" };

/**
 * Clone, apply, commit, push. A push that loses a race is retried by the
 * caller; a file someone else changed since `base` is a conflict, because
 * the agent must read both versions and write one.
 */
export async function pushChanges(input: {
	http: typeof http;
	remote: string;
	token: string;
	base: MemorySnapshot;
	changes: readonly MemoryChange[];
	message: string;
}): Promise<MemoryCommitOutcome | "raced"> {
	let fs = new InMemoryFs();
	const headers = { Authorization: `Bearer ${input.token}` };
	let head: string | null = null;
	try {
		await git.clone({
			fs,
			http: input.http,
			dir: DIR,
			url: input.remote,
			ref: "main",
			singleBranch: true,
			depth: 1,
			noTags: true,
			headers,
		});
		head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
	} catch (error) {
		if (!isEmptyRemote(error)) throw error;
		// A failed clone leaves a partial .git behind; start clean.
		fs = new InMemoryFs();
		await git.init({ fs, dir: DIR, defaultBranch: "main" });
	}
	if (head !== input.base.head) {
		for (const change of input.changes) {
			const current = await fs.promises
				.readFile(`${DIR}/${change.path}`, "utf8")
				.catch(() => null);
			if (current !== (input.base.files[change.path] ?? null))
				return { ok: false, reason: "conflict", current: { head, files: {} } };
		}
	}
	for (const change of input.changes) {
		const target = `${DIR}/${change.path}`;
		if (change.content === null) {
			await fs.promises.unlink(target).catch(() => {});
			await git.remove({ fs, dir: DIR, filepath: change.path });
			continue;
		}
		const parts = change.path.split("/").slice(0, -1);
		for (let depth = 1; depth <= parts.length; depth++)
			await fs.promises
				.mkdir(`${DIR}/${parts.slice(0, depth).join("/")}`)
				.catch(() => {});
		await fs.promises.writeFile(target, change.content);
		await git.add({ fs, dir: DIR, filepath: change.path });
	}
	const hash = await git.commit({
		fs,
		dir: DIR,
		message: input.message,
		author: AUTHOR,
	});
	try {
		const result = await git.push({
			fs,
			http: input.http,
			dir: DIR,
			url: input.remote,
			ref: "main",
			remoteRef: "main",
			headers,
		});
		if (!result.ok) return "raced";
	} catch (error) {
		if (isRejectedPush(error)) return "raced";
		throw error;
	}
	return { ok: true, hash };
}

function isEmptyRemote(error: unknown) {
	const code = (error as { code?: string } | null)?.code;
	return code === "NotFoundError" || code === "NoRefspecError";
}

function isRejectedPush(error: unknown) {
	const code = (error as { code?: string } | null)?.code;
	return code === "PushRejectedError" || code === "GitPushError";
}

/**
 * The Artifacts error code. A remote binding (local `wrangler dev`) passes
 * only the message ("ArtifactsError: Repository not found: …"), so the code
 * is read from the message when it is missing.
 */
export function artifactsCode(error: unknown) {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string") return code;
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/\bnot found\b/i.test(message)) return "NOT_FOUND";
	if (/\balready exists\b/i.test(message)) return "ALREADY_EXISTS";
	return undefined;
}

function tokenFields(created: { id?: string; plaintext: string }) {
	return {
		token: created.plaintext,
		...(created.id ? { tokenId: created.id } : {}),
	};
}

/** Tokens carry `?expires=` for display; Git wants the bare secret. */
function bareToken(token: string) {
	return token.split("?expires=")[0];
}

function epochMs(value: number) {
	return value < 1e12 ? value * 1000 : value;
}
