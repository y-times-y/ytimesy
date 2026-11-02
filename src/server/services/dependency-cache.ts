import { createHash } from "node:crypto";
import {
	DEPENDENCY_CACHE_URL_VARIABLE,
	type DependencyCacheSpec,
	dependencyInputsHashCommand,
	dependencyRestoreCommand,
	dependencyUploadCommand,
} from "#/domain/dependency-cache";
import {
	presignedR2Url,
	r2Configuration,
	r2DeletePrefix,
	r2ObjectSize,
} from "../adapters/checkpoints/r2";

/**
 * Installed dependencies kept in the private R2 bucket, per person and per
 * repository: one person's archive (which may hold private packages their
 * install could fetch) is never another person's, even for the same
 * repository. The key also covers the stack, the install command, the base
 * image and every lockfile and manifest, so a restore is what that install
 * would have produced on that image. Removing the project or the account
 * removes them.
 */
const PREFIX = "dependency-cache/v1";
/** Archives up to this size are fetched within a short (undetached) command. */
const SHORT_RESTORE_BYTES = 96 * 1024 * 1024;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function dependencyCacheEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return env.YTIMESY_DEPENDENCY_CACHE !== "false";
}

export function userDependencyCachePrefix(userId: string) {
	return `${PREFIX}/${hash(`user:${userId}`)}/`;
}

export function repositoryDependencyCachePrefix(
	userId: string,
	repositoryId: number | string,
) {
	return `${userDependencyCachePrefix(userId)}${String(repositoryId).replace(/[^0-9]/g, "")}/`;
}

export function dependencyCacheKey(input: {
	readonly userId: string;
	readonly repositoryId: number | string;
	readonly stack: DependencyCacheSpec["stack"];
	readonly install: string;
	readonly baseSnapshotId: string | null;
	readonly inputsHash: string;
}) {
	if (!/^[a-f0-9]{64}$/.test(input.inputsHash))
		throw new Error("Invalid dependency inputs hash.");
	const identity = hash(
		JSON.stringify([
			input.stack,
			input.install,
			input.baseSnapshotId ?? "",
			input.inputsHash,
		]),
	);
	return `${repositoryDependencyCachePrefix(input.userId, input.repositoryId)}${identity}.tar`;
}

type CacheHost = {
	readonly exec: (
		command: string,
		timeoutMs: number,
	) => Promise<{ exitCode: number; stdout: string }>;
	readonly execWithEnv: (
		command: string,
		env: Record<string, string>,
		timeoutMs: number,
	) => Promise<{ exitCode: number; stdout: string }>;
};

export type DependencyCacheEntry = {
	readonly key: string;
	readonly restored: boolean;
};

/**
 * Restores this install's archive when there is one. Null when the cache
 * does not apply (not configured, no inputs, install scripts a restore cannot
 * replay); a failed restore is a miss, and the install runs as usual.
 */
export async function restoreDependencyCache(input: {
	readonly host: CacheHost;
	readonly directory: string;
	readonly spec: DependencyCacheSpec;
	readonly userId: string;
	readonly repositoryId: number | string;
	readonly install: string;
	readonly baseSnapshotId: string | null;
}): Promise<DependencyCacheEntry | null> {
	if (!dependencyCacheEnabled()) return null;
	const config = r2Configuration();
	if (!config) return null;
	const inputs = await input.host.exec(
		dependencyInputsHashCommand(input.directory, input.spec),
		30_000,
	);
	const inputsHash = inputs.stdout.trim();
	if (inputs.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(inputsHash)) return null;
	const key = dependencyCacheKey({
		...input,
		stack: input.spec.stack,
		inputsHash,
	});
	// A miss is known here, without a guest command; a small archive is
	// restored by a short command (a long one is detached and polled).
	const size = await r2ObjectSize(config, key);
	if (size === null) return { key, restored: false };
	const restored = await input.host.execWithEnv(
		dependencyRestoreCommand(),
		{
			[DEPENDENCY_CACHE_URL_VARIABLE]: presignedR2Url({
				config,
				method: "GET",
				key,
				expiresSeconds: 600,
			}),
		},
		size <= SHORT_RESTORE_BYTES ? 30_000 : 300_000,
	);
	return { key, restored: restored.exitCode === 0 };
}

/** Starts storing what install produced; the build does not wait for it here. */
export async function startDependencyCacheUpload(input: {
	readonly host: CacheHost;
	readonly directory: string;
	readonly spec: DependencyCacheSpec;
	readonly key: string;
}) {
	const config = r2Configuration();
	if (!config) return false;
	const started = await input.host.execWithEnv(
		dependencyUploadCommand(
			input.directory,
			input.spec,
			hash(input.key).slice(0, 32),
		),
		{
			[DEPENDENCY_CACHE_URL_VARIABLE]: presignedR2Url({
				config,
				method: "PUT",
				key: input.key,
				expiresSeconds: 1800,
			}),
		},
		15_000,
	);
	return started.exitCode === 0;
}

/** Removes a person's archives for these repositories (project removal). */
export async function removeRepositoryDependencyCaches(
	userId: string,
	repositoryIds: readonly (number | string)[],
) {
	const config = r2Configuration();
	if (!config) return 0;
	let removed = 0;
	for (const repositoryId of repositoryIds)
		removed += await r2DeletePrefix(
			config,
			repositoryDependencyCachePrefix(userId, repositoryId),
		);
	return removed;
}

/** Removes all of a person's archives (account deletion). */
export async function removeUserDependencyCaches(userId: string) {
	const config = r2Configuration();
	if (!config) return 0;
	return r2DeletePrefix(config, userDependencyCachePrefix(userId));
}
