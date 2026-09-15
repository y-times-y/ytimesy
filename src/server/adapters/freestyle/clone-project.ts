export const PROJECT_TOKEN_PATH = "/tmp/ytimesy-gh-token";
export const PROJECT_CWD_PATH = "/tmp/ytimesy-project-cwd";
export const DEVELOPER_INSTRUCTIONS_PATH =
	"/tmp/ytimesy-developer-instructions.txt";

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

TOKEN="$(cat "$TOKEN_FILE")"
rm -f "$TOKEN_FILE"
if [ -z "$TOKEN" ]; then
  echo "GitHub installation token was empty" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" remote set-url origin "$ORIGIN"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" checkout -B "$BRANCH" FETCH_HEAD
else
  rm -rf "$DEST"
  git clone --depth 1 --branch "$BRANCH" "https://x-access-token:\${TOKEN}@github.com/\${OWNER}/\${NAME}.git" "$DEST"
  git -C "$DEST" remote set-url origin "$ORIGIN"
fi

printf '%s\\n' "$DEST" > ${shellSingleQuote(PROJECT_CWD_PATH)}
echo "PROJECT_CWD=$DEST"
`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
