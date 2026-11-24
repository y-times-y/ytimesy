import { posixShellQuoted } from "#/domain/posix-command";
import { projectCheckoutPath } from "#/domain/project-checkout";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import { receiveBrokeredRepository } from "#/server/adapters/github/git-broker";
import { managedGitSetupCommand } from "#/server/adapters/managed-git-identity";
import {
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
	if (input.commit && !/^[a-f0-9]{40}$/i.test(input.commit))
		throw new Error("Invalid repository revision.");
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
	const setup = managedGitSetupCommand(directory);
	const revision = `git -C ${posixShellQuoted(directory)} rev-parse HEAD`;
	const together = !input.onCloned && input.commit;
	const configured = await runCheckoutCommand(
		input.host,
		together ? `{ ${setup}; } && ${revision}` : setup,
		15_000,
	);
	if (together) assertCommit(configured.stdout, input.commit);
	await input.onCloned?.(directory);
	if (input.commit && !together)
		await runCheckoutCommand(input.host, revision, 15_000).then((result) =>
			assertCommit(result.stdout, input.commit),
		);
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

function assertCommit(stdout: string, commit: string | undefined) {
	// With the hook activated first, the commit is the output's last line.
	if (stdout.trim().split("\n").at(-1)?.trim() !== commit)
		throw new Error("Repository moved during preparation. Retry the build.");
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
