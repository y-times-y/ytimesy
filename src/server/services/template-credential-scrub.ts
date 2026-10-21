import { posixShellQuoted as quote } from "#/domain/posix-command";

/**
 * Credential files package managers and tools write under a home directory.
 * Environment setup runs with build secrets, so `npm login`, `docker login`
 * and similar can leave them behind; the reusable template must not keep them.
 */
export const TEMPLATE_CREDENTIAL_FILES = [
	".npmrc",
	".yarnrc.yml",
	".docker/config.json",
	".netrc",
	".git-credentials",
	".pypirc",
	".config/pip/pip.conf",
	".gem/credentials",
	".cargo/credentials",
	".cargo/credentials.toml",
	".config/gh/hosts.yml",
] as const;

/** Environment variable holding the secret values to search for, one per line. */
export const SCRUB_VALUES_VARIABLE = "YTIMESY_SCRUB_VALUES";

/** Values shorter than this would match ordinary text. */
const MIN_SCRUB_VALUE_LENGTH = 6;

/**
 * The newline-separated secret values for {@link templateCredentialScrub},
 * passed through the environment so they never appear in a command line.
 */
export function scrubValues(secrets: Readonly<Record<string, string>>) {
	return Object.values(secrets)
		.flatMap((value) => value.split("\n"))
		.map((value) => value.trim())
		.filter((value) => value.length >= MIN_SCRUB_VALUE_LENGTH)
		.join("\n");
}

/**
 * Bash run before the template snapshot: removes the known credential files
 * from every home directory, untracked `.env*` files from each checkout, and
 * any other untracked file in a checkout (outside dependency folders) that
 * contains a project secret value.
 */
export function templateCredentialScrub(input: {
	readonly checkouts: readonly string[];
	readonly homes?: readonly string[];
}) {
	const homes = input.homes?.map(quote).join(" ") ?? '/root /home/* "$HOME"';
	const files = TEMPLATE_CREDENTIAL_FILES.map(quote).join(" ");
	const checkouts = input.checkouts.map(quote).join(" ");
	return [
		"set -u",
		`for home in ${homes}; do [ -d "$home" ] || continue; for file in ${files}; do rm -f -- "$home/$file"; done; done`,
		`patterns=$(mktemp) && chmod 600 "$patterns" && printf '%s\\n' "\${${SCRUB_VALUES_VARIABLE}:-}" | grep -v '^$' > "$patterns" || true`,
		`skip='-name node_modules -o -name .git -o -name .venv'`,
		`for checkout in ${checkouts}; do`,
		`  [ -d "$checkout" ] || continue`,
		`  { find "$checkout" \\( $skip \\) -prune -o -type f \\( -name .env -o -name '.env.*' \\) ! -name '*.example' ! -name '*.sample' ! -name '*.template' -print0`,
		`    if [ -s "$patterns" ]; then grep -rlF --null -f "$patterns" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv -- "$checkout" 2>/dev/null; fi`,
		`  } | while IFS= read -r -d '' path; do`,
		`    [ -f "$path" ] && [ ! -L "$path" ] || continue`,
		`    git -C "$checkout" ls-files --error-unmatch -- "\${path#"$checkout"/}" >/dev/null 2>&1 || rm -f -- "$path"`,
		"  done",
		"done",
		`rm -f -- "$patterns"`,
	].join("\n");
}
