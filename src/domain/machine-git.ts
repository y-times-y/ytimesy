import { posixShellQuoted as quote } from "./posix-command";

/**
 * Plain git on a chat's VM reaches GitHub through the edge's git proxy. The
 * agent user's ~/.gitconfig includes ~/.ytimesy-git/config, which rewrites
 * GitHub URLs to the proxy and names a credential helper that trades the
 * chat's short-lived machine token for a one-minute grant per operation. No
 * GitHub credential ever reaches the machine. A token works only while its
 * holder lives: the chat's agent step, or the user's terminal open on the
 * chat (renewed while open). The config goes with the last token, so with no
 * holder git talks to github.com directly as it did before.
 */
export const MACHINE_GIT_HOME_FOLDER = ".ytimesy-git";
export const MACHINE_GIT_INCLUDE = `~/${MACHINE_GIT_HOME_FOLDER}/config`;
/** The edge path the credential helper asks for grants (machine-git-grant.ts). */
export const MACHINE_GIT_GRANT_ROUTE = "/machine-git/grant";

/** A chat id, or a chat id and a terminal connection's id. */
const holderFile = /^[0-9a-f-]{36}(-terminal-[a-f0-9]{16})?$/;
/**
 * Older token files belong to no live holder: a step's token lives at most
 * about 20 minutes, and an open terminal touches its file every 10.
 */
const STALE_TOKEN_FILE_MINUTES = 45;

/** git config text: GitHub URLs to the proxy, and the helper for the proxy's origin. */
export function machineGitConfig(origin: string) {
	return `# ytimesy: plain git reaches GitHub through ytimesy's git proxy with a
# short-lived grant per operation. Written each agent step; removed after it.
[url "${origin}/git/"]
	insteadOf = https://github.com/
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
	insteadOf = git://github.com/
[credential "${origin}"]
	helper =
	helper = !\\"$HOME/${MACHINE_GIT_HOME_FOLDER}/credential-helper\\"
	useHttpPath = true
[http "${origin}/git/"]
	followRedirects = false
`;
}

/**
 * git's credential helper (POSIX sh, curl). The proxy's challenge realm
 * says fetch or push (git 2.41+ passes it as wwwauth[]); older git gets a
 * write grant when one is allowed, else a read grant. A refusal prints the
 * edge's reason for the agent and tells git to stop asking.
 */
export function machineGitCredentialHelper(origin: string) {
	return `#!/bin/sh
# ytimesy: trades this chat's machine token for a short-lived git grant.
[ "\${1:-}" = get ] || exit 0
endpoint=${quote(`${origin}${MACHINE_GIT_GRANT_ROUTE}`)}
tokens="$HOME/${MACHINE_GIT_HOME_FOLDER}/tokens"
path=
access=
while IFS= read -r line; do
	[ -n "$line" ] || break
	case $line in
	path=*) path=\${line#path=} ;;
	"wwwauth[]="*"ytimesy git push"*) access=write ;;
	"wwwauth[]="*"ytimesy git fetch"*) [ -n "$access" ] || access=read ;;
	esac
done
fail() {
	echo "ytimesy: $1" >&2
	echo quit=1
	exit 0
}
repo=\${path#git/}
owner=\${repo%%/*}
name=\${repo#*/}
name=\${name%/}
name=\${name%.git}
case "$repo" in "$path") fail "not a GitHub repository URL: $path" ;; */*) ;; *) fail "not a GitHub repository URL: $path" ;; esac
case "$owner/$name" in
*[!A-Za-z0-9._/-]* | */*/* | .* | */.* | /* | */) fail "not a GitHub repository URL: $path" ;;
esac
command -v curl >/dev/null 2>&1 || fail "git needs curl to reach GitHub here"
grant() {
	refusal="this workspace has no git credentials right now; they arrive with the agent's next step"
	for file in $(ls -t "$tokens" 2>/dev/null); do
		token=$(cat "$tokens/$file" 2>/dev/null) || continue
		response=$(printf 'header = "authorization: Bearer %s"\\n' "$token" |
			curl -sS --max-time 30 -K - -H 'content-type: application/json' \\
				--data "{\\"owner\\":\\"$owner\\",\\"name\\":\\"$name\\",\\"access\\":\\"$1\\"}" \\
				-w '\\n%{http_code}' "$endpoint" 2>/dev/null) || {
			refusal="could not reach ytimesy's git service"
			continue
		}
		status=\${response##*"
"}
		body=\${response%"
"*}
		if [ "$status" = 200 ]; then
			password=$(printf '%s' "$body" | sed -n 's/.*"password":"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
			username=$(printf '%s' "$body" | sed -n 's/.*"username":"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
			[ -n "$password" ] && [ -n "$username" ] || return 1
			printf 'username=%s\\npassword=%s\\n' "$username" "$password"
			return 0
		fi
		reason=$(printf '%s' "$body" | sed -n 's/.*"error":"\\([^"]*\\)".*/\\1/p')
		[ -z "$reason" ] || refusal=$reason
		# An expired token: another chat's on this machine may still work.
		[ "$status" = 401 ] || return 1
	done
	return 1
}
if [ -n "$access" ]; then
	grant "$access" || fail "$refusal"
else
	grant write || grant read || fail "$refusal"
fi
`;
}

/**
 * Writes a holder's token (one file per holder, so chats sharing a VM and a
 * terminal open beside a turn keep theirs), the helper and the config, and
 * includes the config from the agent user's global git config once.
 * Everything is private to that user.
 */
export function machineGitSetupScript(input: {
	origin: string;
	holder: string;
	token: string;
}) {
	if (!holderFile.test(input.holder))
		throw new Error("Invalid holder id for workspace git.");
	const token = quote(input.token);
	return `set -eu
umask 077
d="$HOME/${MACHINE_GIT_HOME_FOLDER}"
if [ -L "$d" ] || { [ -e "$d" ] && [ ! -O "$d" ]; }; then echo "${MACHINE_GIT_HOME_FOLDER} is not this user's directory" >&2; exit 1; fi
mkdir -p "$d/tokens"
chmod 700 "$d" "$d/tokens"
printf '%s' ${token} > "$d/tokens/.${input.holder}"
mv -f "$d/tokens/.${input.holder}" "$d/tokens/${input.holder}"
printf '%s' ${quote(machineGitCredentialHelper(input.origin))} > "$d/.credential-helper"
chmod 700 "$d/.credential-helper"
mv -f "$d/.credential-helper" "$d/credential-helper"
printf '%s' ${quote(machineGitConfig(input.origin))} > "$d/.config"
mv -f "$d/.config" "$d/config"
git config --global --get-all include.path 2>/dev/null | grep -qxF ${quote(MACHINE_GIT_INCLUDE)} ||
	git config --global --add include.path ${quote(MACHINE_GIT_INCLUDE)}`;
}

/**
 * Removes a holder's token (a step's end, a terminal's close), files no
 * holder released in time, and the config with the last token, so git with
 * no holder goes to github.com as before. Never fails.
 */
export function machineGitReleaseScript(holder: string) {
	if (!holderFile.test(holder))
		throw new Error("Invalid holder id for workspace git.");
	return `d="$HOME/${MACHINE_GIT_HOME_FOLDER}"
rm -f "$d/tokens/${holder}"
find "$d/tokens" -type f -mmin +${STALE_TOKEN_FILE_MINUTES} -exec rm -f {} + 2>/dev/null
[ -n "$(ls -A "$d/tokens" 2>/dev/null)" ] || rm -f "$d/config"
true`;
}

/** A terminal still open renews its token; its file is touched so releases keep it. */
export function machineGitTouchScript(holder: string) {
	if (!holderFile.test(holder))
		throw new Error("Invalid holder id for workspace git.");
	return `touch -c "$HOME/${MACHINE_GIT_HOME_FOLDER}/tokens/${holder}"`;
}

/** The token file of a terminal open on a chat; one per connection, so two terminals keep theirs. */
export function terminalMachineGitHolder(
	sessionId: string,
	connection: string,
) {
	const holder = `${sessionId}-terminal-${connection}`;
	if (!holderFile.test(holder))
		throw new Error("Invalid holder id for workspace git.");
	return holder;
}

/** Shell run before any snapshot: every machine token and the config go, proven gone. */
export const SCRUB_MACHINE_GIT_CREDENTIAL = `d="$HOME/${MACHINE_GIT_HOME_FOLDER}"; rm -rf "$d/tokens" "$d/config" && test ! -e "$d/tokens"`;
