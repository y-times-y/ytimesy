import { projectCheckoutPath } from "#/domain/project-checkout";
import {
	cloneSelectedProjectScript,
	PROJECT_CWD_PATH,
	PROJECT_TOKEN_PATH,
} from "#/server/adapters/freestyle/clone-project";
import { resolveGithubAppBot } from "#/server/adapters/github/bot-identity";
import { githubInstallationAccessToken } from "#/server/adapters/github/installation-token";
import {
	activateGithubBotCommitHookArgv,
	githubBotCommitHookPath,
	githubBotCommitMsgHook,
	installArgv,
	listLockfilesArgv,
} from "#/server/adapters/repository-setup";

export type ProjectCheckoutHost = {
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
 * an authenticated provider image. Installation tokens never enter argv.
 */
export async function prepareProjectCheckout(input: {
	readonly host: ProjectCheckoutHost;
	readonly owner: string;
	readonly name: string;
	readonly branch: string;
	readonly workingBranch: string;
	readonly installationId: number | string;
	readonly home: string;
	readonly onCloned?: (directory: string) => Promise<void>;
	readonly onInstalled?: () => Promise<void>;
}) {
	const directory = projectCheckoutPath(input.home, input.name);
	const token = await githubInstallationAccessToken(input.installationId);
	await input.host.writeTextFile(PROJECT_TOKEN_PATH, `${token}\n`);
	await runCheckoutCommand(
		input.host,
		`if [ ! -O '${PROJECT_TOKEN_PATH}' ]; then sudo -n chown "$(id -u):$(id -g)" '${PROJECT_TOKEN_PATH}'; fi
if [ -e '${PROJECT_CWD_PATH}' ] && [ ! -O '${PROJECT_CWD_PATH}' ]; then sudo -n chown "$(id -u):$(id -g)" '${PROJECT_CWD_PATH}'; fi
chmod 600 '${PROJECT_TOKEN_PATH}'`,
		15_000,
	);
	await runCheckoutCommand(
		input.host,
		cloneSelectedProjectScript({
			owner: input.owner,
			name: input.name,
			branch: input.branch,
			workingBranch: input.workingBranch,
			destination: directory,
		}),
		10 * 60 * 1000,
	);
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
