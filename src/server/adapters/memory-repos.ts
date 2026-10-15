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
	): Promise<{ plaintext: string }>;
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
	/** One commit turning `base` into base + `changes`, pushed; a conflicting concurrent edit is reported, not merged. */
	commit(
		base: MemorySnapshot,
		changes: readonly MemoryChange[],
		message: string,
	): Promise<MemoryCommitOutcome>;
	/** Remote URL and a write token for a Git client, creating the repo on first use. */
	credentials(ttlSeconds: number): Promise<{ remote: string; token: string }>;
	/** Commits that changed `path`, newest first, with the file before and after. */
	history(
		path: string,
		limit?: number,
	): Promise<
		(MemoryCommit & { before: string | null; after: string | null })[]
	>;
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

export function artifactsMemoryRepo(
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
			token: (await repo.createToken("write", ttlSeconds)).plaintext,
		}));
		if (existing) return { ...existing, token: bareToken(existing.token) };
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
			token: (await repo.createToken("write", ttlSeconds)).plaintext,
		}));
		if (!created) throw new Error("Memory repo could not be created.");
		return { ...created, token: bareToken(created.token) };
	}

	async function snapshot(): Promise<MemorySnapshot> {
		return (
			(await withRepo(async (repo) => {
				const head = await headCommit(repo);
				if (!head) return { head: null, files: {} };
				const key = `${name}:${head.hash}`;
				const cached = snapshots.get(key);
				if (cached) return { head: head.hash, files: cached };
				const files: MemoryFiles = {};
				const entries = Object.entries(await blobs(repo, head.treeHash));
				for (let start = 0; start < entries.length; start += READ_CONCURRENCY)
					await Promise.all(
						entries
							.slice(start, start + READ_CONCURRENCY)
							.map(async ([path, hash]) => {
								const text = await read(repo, hash);
								if (text !== null) files[path] = text;
							}),
					);
				if (snapshots.size > 64)
					snapshots.delete(snapshots.keys().next().value as string);
				snapshots.set(key, files);
				return { head: head.hash, files };
			})) ?? { head: null, files: {} }
		);
	}

	return {
		name,
		snapshot,
		credentials,
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

function artifactsCode(error: unknown) {
	return (error as { code?: string } | null)?.code;
}

/** Tokens carry `?expires=` for display; Git wants the bare secret. */
function bareToken(token: string) {
	return token.split("?expires=")[0];
}

function epochMs(value: number) {
	return value < 1e12 ? value * 1000 : value;
}
