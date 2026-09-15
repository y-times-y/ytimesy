export const PROJECT_TOKEN_PATH = "/tmp/ytimesy-gh-token";
export const PROJECT_CWD_PATH = "/tmp/ytimesy-project-cwd";
export const DEVELOPER_INSTRUCTIONS_PATH =
	"/tmp/ytimesy-developer-instructions.txt";
export { PROJECT_CONTEXT_PATH } from "#/domain/project-context";

export function redactInstallationToken(text: string): string {
	return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

export function cloneSelectedProjectScript(input: {
	readonly owner: string;
	readonly name: string;
	readonly branch: string;
	readonly destination: string;
}): string {
	return `set -eu
export HOME="\${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"
TOKEN_FILE=${shellSingleQuote(PROJECT_TOKEN_PATH)}
DEST=${shellSingleQuote(input.destination)}
OWNER=${shellSingleQuote(input.owner)}
NAME=${shellSingleQuote(input.name)}
BRANCH=${shellSingleQuote(input.branch)}
ORIGIN="https://github.com/\${OWNER}/\${NAME}.git"
export GIT_TERMINAL_PROMPT=0

apt_get() {
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo -n apt-get "$@"
  else
    apt-get "$@"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends git ca-certificates
fi

mkdir -p "$(dirname "$DEST")"
if [ -d "$DEST/.git" ]; then
  rm -f "$TOKEN_FILE"
  printf '%s\\n' "$DEST" > ${shellSingleQuote(PROJECT_CWD_PATH)}
  echo "PROJECT_CWD=$DEST"
  exit 0
fi

TOKEN="$(tr -d '\\n\\r' < "$TOKEN_FILE")"
rm -f "$TOKEN_FILE"
if [ -z "$TOKEN" ]; then
  echo "GitHub installation token was empty" >&2
  exit 1
fi

rm -rf "$DEST"
git clone --depth 1 --branch "$BRANCH" "https://x-access-token:\${TOKEN}@github.com/\${OWNER}/\${NAME}.git" "$DEST"
git -C "$DEST" remote set-url origin "$ORIGIN"

printf '%s\\n' "$DEST" > ${shellSingleQuote(PROJECT_CWD_PATH)}
echo "PROJECT_CWD=$DEST"
`;
}

export function reusePreparedCheckoutCommand(repoName: string) {
	return `HOME="\${HOME:-/home/ubuntu}"
DEST="$HOME/"${shellSingleQuote(repoName)}
if [ -d "$DEST/.git" ]; then
  printf '%s\\n' "$DEST" > ${shellSingleQuote(PROJECT_CWD_PATH)}
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

export function pushSelectedBranchScript(input: {
	readonly owner: string;
	readonly name: string;
	readonly branch: string;
	readonly directory: string;
}): string {
	return `set -eu
export GIT_TERMINAL_PROMPT=0
TOKEN_FILE=${shellSingleQuote(PROJECT_TOKEN_PATH)}
DEST=${shellSingleQuote(input.directory)}
OWNER=${shellSingleQuote(input.owner)}
NAME=${shellSingleQuote(input.name)}
BRANCH=${shellSingleQuote(input.branch)}
TOKEN="$(tr -d '\\n\\r' < "$TOKEN_FILE")"
rm -f "$TOKEN_FILE"
if [ -z "$TOKEN" ]; then
  echo "GitHub installation token was empty" >&2
  exit 1
fi
git -C "$DEST" push -u "https://x-access-token:\${TOKEN}@github.com/\${OWNER}/\${NAME}.git" "HEAD:\${BRANCH}"
git -C "$DEST" remote set-url origin "https://github.com/\${OWNER}/\${NAME}.git"
`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
