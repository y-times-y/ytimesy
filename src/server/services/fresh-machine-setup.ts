import type { ModelMessage } from "ai";
import { failureMessage } from "#/domain/failure-message";
import {
	backgroundInstallCommand,
	type CaughtUpRepository,
	FRESH_INSTALL_FILES,
	freshMachineEnvironmentReport,
	freshMachineInstall,
	installStatusWaitCommand,
	parseInstallStatus,
	type RepositoryInstall,
	SETUP_INSTALL_FILES,
	SETUP_INSTALL_WAIT_SECONDS,
	type SetupCatchUpInstall,
	setupCatchUpNote,
} from "#/domain/fresh-machine-setup";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { projectCheckoutPath } from "#/domain/project-checkout";
import { ENVIRONMENT_RECIPE_PATH } from "#/domain/project-environment";
import { projectFolderName, repositoriesForProject } from "#/domain/projects";
import { latestEnvironmentRecipes } from "../adapters/environment-recipes";
import { projectForOwner } from "../adapters/projects";
import { guestNodePath } from "../adapters/repository-setup";
import {
	finishSetupCatchUp,
	takeFreshInstallStart,
	takeSetupCatchUp,
} from "../adapters/setup-catch-up";
import type { WorkspaceMachines } from "./workspace-machines";

type GuestMachine = {
	readonly machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">;
	readonly vm: WorkspaceId;
};

/** The project's repositories with the setup saved for each (none before setup saves one). */
async function projectRepositorySetups(userId: string, projectId: string) {
	const [project, saved] = await Promise.all([
		projectForOwner(userId, projectId),
		latestEnvironmentRecipes(userId, projectId),
	]);
	if (!project) throw new Error("Project is not available.");
	return repositoriesForProject(project).map((repo) => ({
		fullName: repo.fullName,
		recipe: saved.get(repo.repositoryId)?.recipe ?? null,
	}));
}

async function guestHome({ machines, vm }: GuestMachine) {
	const result = await machines.exec(vm, `printf '%s' "$HOME"`, 15_000);
	return result.stdout.trim() || "/home/ubuntu";
}

const ENVIRONMENT_REPORT_PATH = "/tmp/ytimesy-environment.json";

/**
 * On a chat machine that booted without the project's template (the
 * project's first build is still running, or failed), once its turn cloned
 * the project: chooses each repository's install as the build would, writes
 * the environment report the agent reads, and starts the installs in the
 * background. Runs once per machine (the boot's catch-up row); never throws.
 */
export async function startFreshMachineInstall(
	guest: GuestMachine,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly sessionId: string;
	},
) {
	try {
		if (!(await takeFreshInstallStart(input.sessionId))) return;
		const [home, repositories] = await Promise.all([
			guestHome(guest),
			projectRepositorySetups(input.userId, input.projectId),
		]);
		const chosen = await Promise.all(
			repositories.map(async (repo) => {
				const directory = projectCheckoutPath(
					home,
					projectFolderName(repo.fullName),
				);
				const listed = await guest.machines.exec(
					guest.vm,
					`ls -1 ${quote(directory)}; printf '\\n${RECIPE_SEPARATOR}\\n'; cat ${quote(`${directory}/${ENVIRONMENT_RECIPE_PATH}`)} 2>/dev/null`,
					15_000,
				);
				const [files = "", fileRecipe = ""] = listed.stdout.split(
					`\n${RECIPE_SEPARATOR}\n`,
				);
				return {
					fullName: repo.fullName,
					directory,
					install: freshMachineInstall({
						files: files.split("\n").map((line) => line.trim()),
						fileRecipe: fileRecipe.trim() || null,
						savedRecipe: repo.recipe,
					}),
				};
			}),
		);
		await guest.machines.writeTextFile(
			guest.vm,
			ENVIRONMENT_REPORT_PATH,
			JSON.stringify(freshMachineEnvironmentReport(chosen)),
		);
		const installs = chosen.flatMap((repo): RepositoryInstall[] =>
			repo.install
				? [{ directory: repo.directory, install: repo.install }]
				: [],
		);
		if (!installs.length) return;
		await guest.machines.exec(
			guest.vm,
			backgroundInstallCommand({
				installs,
				files: FRESH_INSTALL_FILES,
				prelude: guestNodePath(),
				terminal: "ytimesy-install",
			}),
			30_000,
		);
	} catch (error) {
		console.warn("A fresh chat machine's install could not be started.", {
			message: failureMessage(error).slice(0, 200),
		});
	}
}

const RECIPE_SEPARATOR = "--- ytimesy environment.json ---";

export type SetupCatchUpDependencies = {
	readonly take: (sessionId: string) => Promise<boolean>;
	readonly finish: (sessionId: string) => Promise<void>;
	readonly repositories: (
		userId: string,
		projectId: string,
	) => Promise<
		readonly {
			readonly fullName: string;
			readonly recipe: CaughtUpRepository["recipe"] | null;
		}[]
	>;
};

const catchUpDependencies: SetupCatchUpDependencies = {
	take: takeSetupCatchUp,
	finish: finishSetupCatchUp,
	repositories: projectRepositorySetups,
};

/**
 * Before a model step (never while a command runs), once the step's inbox
 * read found the catch-up ready: a chat that started before the project's
 * setup and whose setup has since saved its recipe
 * gets the recipe's install run on its machine by us, without the model,
 * then one note. The install is waited for until `waitUntil` (at most
 * SETUP_INSTALL_WAIT_SECONDS); one still running is named as such. A
 * failure to run it is in the note too; the chat always continues.
 */
export async function withSetupCatchUp(
	input: {
		readonly sessionId: string;
		readonly userId: string;
		readonly projectId: string;
		readonly messages: ModelMessage[];
		readonly workspace: () => Promise<GuestMachine>;
		/** When the step must stop waiting for the install (its command-wait deadline). */
		readonly waitUntil: number;
		readonly now?: () => number;
	},
	dependencies: SetupCatchUpDependencies = catchUpDependencies,
): Promise<{ messages: ModelMessage[]; changed: boolean }> {
	if (!(await dependencies.take(input.sessionId)))
		return { messages: input.messages, changed: false };
	try {
		const saved = (
			await dependencies.repositories(input.userId, input.projectId)
		).flatMap((repo): CaughtUpRepository[] =>
			repo.recipe ? [{ fullName: repo.fullName, recipe: repo.recipe }] : [],
		);
		const install = await runSetupInstall(input, saved);
		return {
			messages: [
				...input.messages,
				{
					role: "user",
					content: setupCatchUpNote({ repositories: saved, install }),
				},
			],
			changed: true,
		};
	} finally {
		await dependencies.finish(input.sessionId).catch(() => undefined);
	}
}

async function runSetupInstall(
	input: Parameters<typeof withSetupCatchUp>[0],
	saved: readonly CaughtUpRepository[],
): Promise<SetupCatchUpInstall> {
	if (!saved.some((repo) => repo.recipe.install)) return { state: "none" };
	try {
		const guest = await input.workspace();
		const home = await guestHome(guest);
		const installs = saved.flatMap((repo): RepositoryInstall[] =>
			repo.recipe.install
				? [
						{
							directory: projectCheckoutPath(
								home,
								projectFolderName(repo.fullName),
							),
							install: repo.recipe.install,
						},
					]
				: [],
		);
		const started = await guest.machines.exec(
			guest.vm,
			backgroundInstallCommand({
				installs,
				files: SETUP_INSTALL_FILES,
				prelude: guestNodePath(),
				// The boot's own install may still be running: this one waits for it.
				after: FRESH_INSTALL_FILES,
				terminal: "ytimesy-setup-install",
			}),
			30_000,
		);
		if (started.exitCode !== 0)
			return {
				state: "failed-to-start",
				reason: `exit ${started.exitCode}`,
			};
		const now = input.now ?? Date.now;
		const seconds = Math.min(
			SETUP_INSTALL_WAIT_SECONDS,
			Math.max(0, Math.floor((input.waitUntil - now()) / 1000)),
		);
		const waited = await guest.machines.exec(
			guest.vm,
			installStatusWaitCommand(SETUP_INSTALL_FILES, seconds),
			(seconds + 30) * 1000,
		);
		return parseInstallStatus(waited.stdout);
	} catch (error) {
		return {
			state: "failed-to-start",
			reason: failureMessage(error).slice(0, 160),
		};
	}
}
