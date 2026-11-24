import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	DIRTY_BRANCH_SWITCH_MESSAGE,
	fetchedBranchCommand,
} from "#/domain/git-branch-switch";
import { posixShellQuoted as quote } from "#/domain/posix-command";

export { switchBrokeredBranchCommand } from "#/domain/git-branch-switch";

import {
	allManagedGitIdentities,
	GIT_IDENTITY_FORMAT,
} from "../managed-git-identity";
import {
	gitProxyConfiguration,
	pushProxiedRepository,
	receiveProxiedRepository,
} from "./git-proxy-transfer";
import { githubInstallationAccessToken } from "./installation-token";

const execute = promisify(execFile);
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface GitTransferHost {
	exec(
		command: string,
		timeoutMs: number,
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	writeTextFile(path: string, contents: string): Promise<void>;
	readTextFile?(path: string): Promise<string | null>;
	/**
	 * Runs a command with extra environment variables that are not part of
	 * the command's text (a capability must not land in logs or journals).
	 * A host that has it clones in one command instead of seven.
	 */
	execWithEnv?(
		command: string,
		env: Record<string, string>,
		timeoutMs: number,
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

type Repository = {
	userId?: string;
	projectId?: string;
	owner: string;
	name: string;
	branch: string;
	installationId: number | string;
};

function repositoryUrl(input: Repository) {
	if (
		![input.owner, input.name].every((part) =>
			/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part),
		)
	)
		throw new Error("Invalid GitHub repository.");
	return `https://github.com/${input.owner}/${input.name}.git`;
}

/** Git never checks out untrusted files or inherits application secrets on the broker. */
async function withGitBroker<T>(
	operation: (
		git: (args: string[], token?: string) => Promise<string>,
		directory: string,
	) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-git-"));
	const git = async (args: string[], token?: string) => {
		try {
			const { stdout } = await execute(
				"git",
				[
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"protocol.ext.allow=never",
					"-c",
					"fetch.fsckObjects=true",
					"-c",
					"transfer.fsckObjects=true",
					...args,
				],
				{
					cwd: directory,
					timeout: 120_000,
					maxBuffer: 1024 * 1024,
					env: {
						PATH: process.env.PATH,
						HOME: directory,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						GIT_ALLOW_PROTOCOL: "https:file",
						...(token
							? {
									GIT_CONFIG_COUNT: "1",
									GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
									GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
								}
							: {}),
					},
				},
			);
			return stdout.trim();
		} catch {
			throw new Error(
				"GitHub transfer failed. Check repository access and retry; no credential was sent to the workspace.",
			);
		}
	};
	try {
		return await operation(git, directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function checked(host: GitTransferHost, command: string) {
	const result = await host.exec(command, 120_000);
	if (result.exitCode !== 0)
		throw new Error(
			"Workspace Git transfer failed; no GitHub credential was sent to it.",
		);
	return result.stdout.trim();
}

/** Installs/fetches credential-free Git objects, never a GitHub token, in the guest. */
export async function receiveBrokeredRepository(
	host: GitTransferHost,
	input: Repository & {
		destination: string;
		workingBranch?: string;
		mode: "clone" | "update" | "switch";
		/** See fetchedBranchCommand. */
		pinnedRevision?: string;
	},
): Promise<string> {
	if (gitProxyConfiguration()) return receiveProxiedRepository(host, input);
	const url = repositoryUrl(input);
	await checked(host, "rm -f /tmp/ytimesy-gh-token");
	return withGitBroker(async (git, directory) => {
		await git(["check-ref-format", "--branch", input.branch]);
		await git([
			"check-ref-format",
			"--branch",
			input.workingBranch || input.branch,
		]);
		if (input.mode !== "clone") {
			const state = await checked(
				host,
				`git -C ${quote(input.destination)} status --porcelain`,
			);
			if (state) {
				if (input.mode === "switch")
					throw new Error(DIRTY_BRANCH_SWITCH_MESSAGE);
				return "dirty";
			}
		}
		const token = await githubInstallationAccessToken(input.installationId, {
			repositoryNames: [input.name],
			contents: "read",
		});
		await git(["init", "--bare", "repo.git"]);
		await git(
			[
				"-C",
				"repo.git",
				"fetch",
				"--no-tags",
				url,
				`refs/heads/${input.branch}:refs/heads/source`,
			],
			token,
		);
		const bundle = join(directory, "source.bundle");
		await git([
			"-C",
			"repo.git",
			"bundle",
			"create",
			bundle,
			"refs/heads/source",
		]);
		if ((await stat(bundle)).size > MAX_BUNDLE_BYTES)
			throw new Error("Repository transfer exceeds the 64 MiB safety limit.");
		const transfer = `/tmp/ytimesy-git-${randomUUID()}`;
		try {
			await host.writeTextFile(
				`${transfer}.b64`,
				(await readFile(bundle)).toString("base64"),
			);
			const dest = quote(input.destination);
			await checked(
				host,
				// Only the bundle is private: the checkout keeps the VM's umask so
				// a read-only helper (another Linux user) can read it.
				`set -eu
(umask 077; base64 -d < ${quote(`${transfer}.b64`)} > ${quote(transfer)})
${input.mode === "clone" ? `test ! -e ${dest}\nmkdir -p ${dest}\ngit -C ${dest} init` : `test -z "$(git -C ${dest} status --porcelain)"`}
git -C ${dest} -c core.hooksPath=/dev/null fetch --no-tags ${quote(transfer)} refs/heads/source
${fetchedBranchCommand({
	directory: input.destination,
	branch: input.branch,
	workingBranch: input.workingBranch || input.branch,
	mode: input.mode,
	originUrl: url,
	pinnedRevision: input.pinnedRevision,
})}
echo updated`,
			);
			return "updated";
		} finally {
			await host
				.exec(`rm -f ${quote(transfer)} ${quote(`${transfer}.b64`)}`, 10_000)
				.catch(() => undefined);
		}
	});
}

/** Pushes a verified guest bundle from a fresh bare repository with server-only auth. */
export async function pushBrokeredRepository(
	host: GitTransferHost,
	input: Repository & {
		directory: string;
		baseBranch?: string;
		revision?: string;
	},
): Promise<void> {
	if (gitProxyConfiguration()) return pushProxiedRepository(host, input);
	if (
		input.revision &&
		!/^refs\/ytimesy\/turn-commits\/[a-f0-9]{64}$/.test(input.revision)
	)
		throw new Error("Invalid completed-turn revision.");
	const revision = input.revision || "HEAD";
	const url = repositoryUrl(input);
	if (!host.readTextFile)
		throw new Error(
			"Workspace file transfer is unavailable; no push was attempted.",
		);
	const readTextFile = host.readTextFile.bind(host);
	await withGitBroker(async (git, directory) => {
		await git(["check-ref-format", "--branch", input.branch]);
		if (input.baseBranch)
			await git(["check-ref-format", "--branch", input.baseBranch]);
		const transfer = `/tmp/ytimesy-git-${randomUUID()}`;
		let encoded: string | null;
		try {
			await checked(
				host,
				`set -eu
umask 077
git -C ${quote(input.directory)} bundle create ${quote(transfer)} ${quote(revision)}
test "$(wc -c < ${quote(transfer)})" -le ${MAX_BUNDLE_BYTES}
base64 < ${quote(transfer)} > ${quote(`${transfer}.b64`)}`,
			);
			encoded = await readTextFile(`${transfer}.b64`);
		} finally {
			await host
				.exec(`rm -f ${quote(transfer)} ${quote(`${transfer}.b64`)}`, 10_000)
				.catch(() => undefined);
		}
		if (
			!encoded ||
			encoded.length > MAX_BUNDLE_BYTES * 1.4 ||
			!/^[A-Za-z0-9+/=\s]+$/.test(encoded)
		)
			throw new Error("Workspace bundle is missing or too large.");
		const bundle = join(directory, "guest.bundle");
		await writeFile(bundle, Buffer.from(encoded, "base64"), { mode: 0o600 });
		await git(["init", "--bare", "repo.git"]);
		const token = await githubInstallationAccessToken(input.installationId, {
			repositoryNames: [input.name],
			contents: "write",
		});
		if (input.baseBranch)
			await git(
				[
					"-C",
					"repo.git",
					"fetch",
					"--no-tags",
					url,
					`refs/heads/${input.baseBranch}:refs/heads/base`,
				],
				token,
			);
		await git(["-C", "repo.git", "bundle", "verify", bundle]);
		await git([
			"-C",
			"repo.git",
			"fetch",
			"--no-tags",
			bundle,
			`${revision}:refs/heads/publish`,
		]);
		await git(
			[
				"-C",
				"repo.git",
				"fetch",
				"--no-tags",
				url,
				"refs/heads/*:refs/ytimesy/upstream/*",
			],
			token,
		);
		const identities = await git([
			"-C",
			"repo.git",
			"--no-replace-objects",
			"log",
			`--format=${GIT_IDENTITY_FORMAT}`,
			"refs/heads/publish",
			"--not",
			"--glob=refs/ytimesy/upstream/*",
		]);
		if (!allManagedGitIdentities(identities))
			throw new Error(
				"Push refused: an unpublished commit does not have the managed Git identity.",
			);
		await git(
			[
				"-C",
				"repo.git",
				"push",
				url,
				`refs/heads/publish:refs/heads/${input.branch}`,
			],
			token,
		);
	});
}
