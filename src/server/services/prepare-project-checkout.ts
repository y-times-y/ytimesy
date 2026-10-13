import { posixShellQuoted } from "#/domain/posix-command";
import { projectCheckoutPath } from "#/domain/project-checkout";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import { resolveGithubAppBot } from "#/server/adapters/github/bot-identity";
import { receiveBrokeredRepository } from "#/server/adapters/github/git-broker";
import {
	activateGithubBotCommitHookArgv,
	githubBotCommitHookPath,
	githubBotCommitMsgHook,
	installArgv,
	listLockfilesArgv,
} from "#/server/adapters/repository-setup";

type ProjectCheckoutHost = {
	readonly exec: (
		command: string,
		timeoutMs: number,
	) => Promise<{
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;
	}>;
	readonly writeTextFile: (path: string, contents: string) => Promise<void>;
};

/**
 * The same checkout/install recipe prepares both the initial project image and
 * an authenticated provider image. GitHub auth stays on the server broker.
 */
export async function prepareProjectCheckout(input: {
	readonly userId?: string;
	readonly projectId?: string;
	readonly host: ProjectCheckoutHost;
	readonly owner: string;
	readonly name: string;
	readonly branch: string;
	readonly workingBranch: string;
	readonly installationId: number | string;
	readonly home: string;
	readonly onCloned?: (directory: string) => Promise<void>;
	readonly onInstalled?: () => Promise<void>;
	readonly install?: boolean;
	readonly commit?: string;
}) {
	const directory = projectCheckoutPath(input.home, input.name);
	const exists = await input.host.exec(
		`test -d ${posixShellQuoted(`${directory}/.git`)} && echo present`,
		15_000,
	);
	if (!exists.stdout.includes("present"))
		await receiveBrokeredRepository(input.host, {
			...input,
			destination: directory,
			mode: "clone",
		});
	await input.host.writeTextFile(PROJECT_CWD_PATH, `${directory}\n`);
	const bot = await resolveGithubAppBot();
	if (bot) {
		const hook = githubBotCommitHookPath(directory);
		await input.host.writeTextFile(hook, githubBotCommitMsgHook(bot));
		await runCheckoutCommand(
			input.host,
			activateGithubBotCommitHookArgv(directory)[2],
			15_000,
		);
	}
	await input.onCloned?.(directory);
	if (input.commit) {
		if (!/^[a-f0-9]{40}$/i.test(input.commit))
			throw new Error("Invalid repository revision.");
		await runCheckoutCommand(
			input.host,
			`git -C ${posixShellQuoted(directory)} rev-parse HEAD`,
			15_000,
		).then((result) => {
			if (result.stdout.trim() !== input.commit)
				throw new Error(
					"Repository moved during preparation. Retry the build.",
				);
		});
	}
	if (input.install === false) return directory;
	const listing = await runCheckoutCommand(
		input.host,
		listLockfilesArgv(directory)[2],
		30_000,
	);
	const lockfiles = listing.stdout.split("\n").map((line) => line.trim());
	await runCheckoutCommand(
		input.host,
		installArgv(directory, lockfiles)[2],
		15 * 60 * 1000,
	);
	await input.onInstalled?.();
	return directory;
}

async function runCheckoutCommand(
	host: ProjectCheckoutHost,
	command: string,
	timeoutMs: number,
) {
	const result = await host.exec(command, timeoutMs);
	if (result.exitCode !== 0) {
		throw new Error(
			result.stderr.trim() ||
				result.stdout.trim() ||
				`Workspace command failed (exit ${result.exitCode}).`,
		);
	}
	return result;
}
