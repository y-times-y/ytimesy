/**
 * What a repository's environment setup is, when nobody saved one: the
 * install a lockfile or manifest implies. Detection only sets defaults; a
 * repository it does not recognize still gets a machine with its checkout.
 */

/** Where a repository's setup came from in a build. */
export type EnvironmentSetupSource =
	/** Saved in Settings or by the setup agent. */
	| "saved"
	/** The repository's own .ytimesy/environment.json. */
	| "file"
	/** Inferred from a lockfile or manifest. */
	| "detected"
	/** Nothing recognized: the checkout only. */
	| "none"
	/** Setup skipped on request ("Send anyway"): the checkout only. */
	| "plain";

export type DetectedEnvironment = {
	/** "Node (pnpm)", "Python (uv)"…; null when nothing was recognized. */
	readonly label: string | null;
	readonly install?: string;
	readonly checks: readonly string[];
};

export type EnvironmentCommandOutcome = {
	readonly command: string;
	readonly exitCode: number;
	/** The last lines of output, redacted. */
	readonly output: string;
};

/** One repository's setup as a build applied it (environment_build.setup). */
export type RepositorySetup = {
	readonly repositoryId: number;
	readonly fullName: string;
	readonly source: EnvironmentSetupSource;
	readonly detected?: string | null;
	readonly install?: string | null;
	/** A detected install that failed; the build continued without it. */
	readonly installFailure?: EnvironmentCommandOutcome | null;
};

/** The repository's top-level file names (from `ls -1`). */
export function detectEnvironment(
	files: readonly string[],
	packageScripts: Readonly<Record<string, unknown>> = {},
): DetectedEnvironment {
	const has = (name: string) => files.includes(name);
	if (has("package.json")) {
		const manager = has("pnpm-lock.yaml")
			? "pnpm"
			: has("yarn.lock")
				? "yarn"
				: "npm";
		const run = manager === "npm" ? "npm" : (`corepack ${manager}` as const);
		const install =
			manager === "pnpm"
				? "corepack pnpm install --frozen-lockfile"
				: manager === "yarn"
					? "corepack yarn install --frozen-lockfile"
					: has("package-lock.json")
						? "npm ci"
						: "npm install --no-package-lock";
		return {
			label: `Node (${manager})`,
			install,
			checks: ["typecheck", "build", "test"]
				.filter((name) => typeof packageScripts[name] === "string")
				.map((name) => `${run} run ${name}`),
		};
	}
	if (has("uv.lock"))
		return {
			label: "Python (uv)",
			install:
				"command -v uv >/dev/null 2>&1 || python3 -m pip install --user --quiet uv; uv sync --frozen",
			checks: [],
		};
	if (has("poetry.lock"))
		return {
			label: "Python (Poetry)",
			install:
				"command -v poetry >/dev/null 2>&1 || python3 -m pip install --user --quiet poetry; poetry install --no-interaction --no-root",
			checks: [],
		};
	if (has("requirements.txt"))
		return {
			label: "Python (pip)",
			install:
				"python3 -m venv .venv && .venv/bin/python -m pip install --quiet -r requirements.txt",
			checks: [],
		};
	if (has("go.mod"))
		return { label: "Go", install: "go mod download", checks: [] };
	if (has("Cargo.toml"))
		return { label: "Rust", install: "cargo fetch", checks: [] };
	return { label: null, checks: [] };
}

/** A repository without its own setup (saved or in the repository). */
export function setupIsMissing(setup: Pick<RepositorySetup, "source">) {
	return (
		setup.source === "none" ||
		setup.source === "plain" ||
		setup.source === "detected"
	);
}

/**
 * What the agent is told when a repository has no verified setup: install
 * what the task needs, and point the user at Rerun setup.
 */
export function environmentSetupNotice(
	setups: readonly RepositorySetup[],
): string | null {
	const lines = setups.flatMap((setup) => {
		if (setup.source === "plain")
			return [
				`${setup.fullName}: setup was skipped (the person chose to send on a plain machine); only the repository is cloned and no dependencies are installed.`,
			];
		if (setup.source === "none")
			return [
				`${setup.fullName}: no saved environment setup, and no lockfile or manifest was recognized; only the repository is cloned.`,
			];
		if (setup.source === "detected" && setup.installFailure)
			return [
				`${setup.fullName}: no saved environment setup; the detected install \`${setup.installFailure.command}\` failed (exit ${setup.installFailure.exitCode}), so dependencies may be missing.`,
			];
		return [];
	});
	if (!lines.length) return null;
	return `${lines.join(" ")} Install what this task needs yourself before building or testing. Mention once that the person can use Rerun setup to save a verified setup for future chats.`;
}

/** Settings' one line for a repository without a saved setup. */
export function detectedSetupLine(setup: RepositorySetup | null | undefined) {
	if (!setup) return "Not set up yet.";
	if (setup.source === "file")
		return "Using .ytimesy/environment.json from the repository.";
	if (setup.source === "plain")
		return "Not set up yet: setup was skipped, chats start with the checkout only.";
	if (setup.source === "none")
		return "Not set up yet: nothing detected, chats start with the checkout only.";
	if (setup.source === "detected")
		return setup.installFailure
			? `Not set up yet: ${setup.detected ?? "detected"} install failed (exit ${setup.installFailure.exitCode}).`
			: `Not set up yet: ${setup.detected ?? "detected"}, installs with ${setup.install ?? "its lockfile"}.`;
	return null;
}

/**
 * Whether to offer "Rerun setup": until one repository has a setup of
 * its own, saved in ytimesy or committed as .ytimesy/environment.json (seen
 * by the active build).
 */
export function offersEnvironmentSetup(
	repositories: readonly {
		readonly saved: unknown;
		readonly setup?: Pick<RepositorySetup, "source"> | null;
	}[],
) {
	return !repositories.some(
		(repo) => Boolean(repo.saved) || repo.setup?.source === "file",
	);
}
