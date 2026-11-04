import { detectEnvironment } from "./environment-detection";
import { posixShellQuoted as quote } from "./posix-command";
import {
	type EnvironmentRecipe,
	parseEnvironmentRecipe,
} from "./project-environment";
import { SOURCE_AGENT_SECRETS } from "./project-secret";

/**
 * A chat whose project has no template yet does not wait for one: its
 * machine boots from the shared tools image, the turn clones the project,
 * and the install runs in the background while the agent works. Once the
 * project's setup saves its recipe, the chat catches up at its next model
 * step: we run the recipe's install there, then the agent gets one note.
 */

/** A background install's files, relative to the guest's $HOME. */
export type BackgroundInstallFiles = {
	readonly log: string;
	readonly status: string;
};

/** The install a fresh machine starts as soon as its checkout is there. */
export const FRESH_INSTALL_FILES: BackgroundInstallFiles = {
	log: ".ytimesy/install.log",
	status: ".ytimesy/install.status",
};

/** The saved recipe's install, run when the project's setup finishes. */
export const SETUP_INSTALL_FILES: BackgroundInstallFiles = {
	log: ".ytimesy/setup-install.log",
	status: ".ytimesy/setup-install.status",
};

/** How long a model step waits for the setup's install before its note says it still runs. */
export const SETUP_INSTALL_WAIT_SECONDS = 300;

const shown = (path: string) => `~/${path}`;

/** The chat's one line when it caught up with the project's setup. */
export const SETUP_CAUGHT_UP_NOTICE =
	"Project setup finished; this chat's machine caught up.";

/** What the agent on a fresh machine is told, once, at its next model step. */
export function freshMachineNotice() {
	return `This machine started before the project's setup finished, so it has the repository but not a prepared environment. Dependencies are installing in the background (log: ${shown(FRESH_INSTALL_FILES.log)}; ${shown(FRESH_INSTALL_FILES.status)} holds the exit code once it is done). Read, plan and edit now; before you rely on dependencies, check that file, and install what you need yourself if the install failed or is missing. Another note follows when the project's setup is saved.`;
}

/**
 * The install a fresh machine runs for one repository, as the environment
 * build would choose it: the saved setup, then the repository's own
 * .ytimesy/environment.json, then what its lockfile or manifest implies.
 * Null when there is nothing to install.
 */
export function freshMachineInstall(input: {
	/** The repository's top-level file names. */
	readonly files: readonly string[];
	/** The repository's .ytimesy/environment.json, when it has one. */
	readonly fileRecipe: string | null;
	readonly savedRecipe?: Pick<EnvironmentRecipe, "install"> | null;
}): string | null {
	const detected = detectEnvironment(input.files).install ?? null;
	const nodeInstall = input.files.includes("package.json") ? detected : null;
	if (input.savedRecipe)
		return input.savedRecipe.install ?? nodeInstall ?? null;
	if (input.fileRecipe?.trim()) {
		try {
			return parseEnvironmentRecipe(input.fileRecipe).install ?? nodeInstall;
		} catch {
			// Not a valid setup: the build falls back to the detected defaults too.
		}
	}
	return detected;
}

export type RepositoryInstall = {
	readonly directory: string;
	readonly install: string;
};

/**
 * Starts the installs in a detached terminal and returns at once. Each
 * repository's install runs in its root with the project's variables (the
 * env file each turn writes) and `prelude` (the guest's tool paths); a
 * failure does not stop the next repository. The status file gets
 * `exit <first non-zero code, or 0>` once all are done. With `after`, it
 * first waits (bounded) for that install to finish, so two installs never
 * write the same dependencies at once.
 */
export function backgroundInstallCommand(input: {
	readonly installs: readonly RepositoryInstall[];
	readonly files: BackgroundInstallFiles;
	readonly prelude: string;
	readonly after?: BackgroundInstallFiles;
	/** The detached terminal's name; one per kind of install. */
	readonly terminal: string;
}) {
	const { files } = input;
	const waitForEarlier = input.after
		? `for _ in $(seq 1 900); do
  if [ ! -e "$HOME/${input.after.log}" ] || [ -e "$HOME/${input.after.status}" ]; then break; fi
  sleep 2
done
`
		: "";
	const repositories = input.installs
		.map(
			({ directory, install }) =>
				`printf '== %s\\n' ${quote(`${directory}: ${install}`)}
( cd ${quote(directory)} && ${input.prelude} && ${SOURCE_AGENT_SECRETS} && export CI=true && ${install} )
result=$?
if [ "$result" -ne 0 ] && [ "$code" -eq 0 ]; then code=$result; fi`,
		)
		.join("\n");
	// No `set -u`: nvm's script (in the prelude) reads unset variables.
	const script = `exec >"$HOME/${files.log}" 2>&1 </dev/null
${waitForEarlier}code=0
${repositories}
printf 'exit %s\\n' "$code" > "$HOME/${files.status}.tmp"
mv "$HOME/${files.status}.tmp" "$HOME/${files.status}"`;
	const launch = `mkdir -p "$HOME/.ytimesy"
rm -f "$HOME/${files.status}"
: > "$HOME/${files.log}"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t ${quote(input.terminal)} 2>/dev/null
  tmux new-session -d -s ${quote(input.terminal)} bash -c ${quote(script)}
elif command -v setsid >/dev/null 2>&1; then
  nohup setsid bash -c ${quote(script)} >/dev/null 2>&1 </dev/null &
else
  nohup bash -c ${quote(script)} >/dev/null 2>&1 </dev/null &
fi
echo started`;
	return `bash -c ${quote(launch)}`;
}

/** Waits up to `seconds` for a background install's status; prints it, or `running`. */
export function installStatusWaitCommand(
	files: BackgroundInstallFiles,
	seconds: number,
) {
	const rounds = Math.max(0, Math.floor(seconds / 2));
	return `bash -c ${quote(`for _ in $(seq 0 ${rounds}); do
  if [ -e "$HOME/${files.status}" ]; then cat "$HOME/${files.status}"; exit 0; fi
  [ ${rounds} -eq 0 ] || sleep 2
done
echo running`)}`;
}

export type BackgroundInstallState =
	| { readonly state: "done"; readonly exitCode: number }
	| { readonly state: "running" };

export function parseInstallStatus(stdout: string): BackgroundInstallState {
	const done = /^exit (\d+)\s*$/m.exec(stdout);
	return done
		? { state: "done", exitCode: Number(done[1]) }
		: { state: "running" };
}

/** What the setup saved for one repository, as the catch-up note names it. */
export type CaughtUpRepository = {
	readonly fullName: string;
	readonly recipe: Pick<EnvironmentRecipe, "install" | "services"> &
		Partial<Pick<EnvironmentRecipe, "unverified">>;
};

export type SetupCatchUpInstall =
	| BackgroundInstallState
	| { readonly state: "none" }
	| { readonly state: "failed-to-start"; readonly reason: string };

/**
 * The one note a chat that started before the project's setup gets once
 * the setup saved its recipe: what was installed on its machine, the
 * services, and what the setup left unverified.
 */
export function setupCatchUpNote(input: {
	readonly repositories: readonly CaughtUpRepository[];
	readonly install: SetupCatchUpInstall;
}) {
	const installs = input.repositories.flatMap((repo) =>
		repo.recipe.install ? [`\`${repo.recipe.install}\``] : [],
	);
	const log = shown(SETUP_INSTALL_FILES.log);
	const install = (() => {
		const commands = installs.join(", ");
		switch (input.install.state) {
			case "none":
				return "It saved no install command, so nothing was installed here.";
			case "failed-to-start":
				return `Its install (${commands}) could not be run on this machine (${input.install.reason}); run it yourself if you need it.`;
			case "running":
				return `Its install (${commands}) is still running on this machine (log: ${log}; ${shown(SETUP_INSTALL_FILES.status)} gets the exit code); check it before relying on new dependencies.`;
			case "done":
				return input.install.exitCode === 0
					? `Its install (${commands}) ran on this machine and passed.`
					: `Its install (${commands}) ran on this machine and failed (exit ${input.install.exitCode}; log: ${log}); fix or rerun it if your work needs it.`;
		}
	})();
	const services = input.repositories.flatMap((repo) =>
		repo.recipe.services.map(
			(service) =>
				`${service.name} (\`${service.command}\`, port ${service.port})`,
		),
	);
	const unverified = input.repositories.flatMap((repo) =>
		(repo.recipe.unverified ?? []).map(
			(item) => `${item.what} (${item.reason})`,
		),
	);
	return [
		"System note: the project's setup finished and saved how this project is set up.",
		install,
		services.length
			? `Services, not started here (start one when you need it): ${services.join("; ")}.`
			: "",
		unverified.length ? `Left unverified: ${unverified.join("; ")}.` : "",
		"Continue your task.",
	]
		.filter(Boolean)
		.join(" ");
}

/** The environment report a fresh machine's agent reads (read_environment_report, environment.md). */
export function freshMachineEnvironmentReport(
	repositories: readonly {
		readonly fullName: string;
		readonly directory: string;
		readonly install: string | null;
	}[],
) {
	return {
		version: 1,
		notice: freshMachineNotice(),
		repositories: repositories.map((repo) => ({
			fullName: repo.fullName,
			directory: repo.directory,
			recipe: repo.install ? { install: repo.install } : {},
		})),
	};
}
