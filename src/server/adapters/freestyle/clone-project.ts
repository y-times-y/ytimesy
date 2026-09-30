import { posixShellQuoted } from "#/domain/posix-command";

export const PROJECT_CWD_PATH = "/tmp/ytimesy-project-cwd";
export const DEVELOPER_INSTRUCTIONS_PATH =
	"/tmp/ytimesy-developer-instructions.txt";
export { PROJECT_CONTEXT_PATH } from "#/domain/project-context";

export function reusePreparedCheckoutCommand(repoName: string) {
	return `HOME="\${HOME:-/home/ubuntu}"
DEST="$HOME/"${posixShellQuoted(repoName)}
if [ -d "$DEST/.git" ]; then
  echo present
  echo "$DEST"
fi`;
}

export function preparedCheckoutPathFromReuse(stdout: string): string | null {
	const lines = stdout.split(/\r?\n/);
	const index = lines.findIndex((line) => line.trim() === "present");
	if (index < 0) return null;
	const path = lines[index + 1]?.trim() ?? "";
	return path.startsWith("/") ? path : null;
}
