import { posixShellQuoted as quote } from "./posix-command";

/**
 * Plain git on a chat's VM reaches GitHub through the edge's git proxy. The
 * agent user's ~/.gitconfig includes ~/.ytimesy-git/config, which rewrites
 * GitHub URLs to the proxy and names a credential helper that trades the
 * chat's short-lived machine token for a one-minute grant per operation. No
 * GitHub credential ever reaches the machine; the token works only while the
 * chat's step runs, and the config goes with the last token, so between
 * turns git talks to github.com directly as it did before.
 */
export const MACHINE_GIT_HOME_FOLDER = ".ytimesy-git";
export const MACHINE_GIT_INCLUDE = `~/${MACHINE_GIT_HOME_FOLDER}/config`;
/** The edge path the credential helper asks for grants (machine-git-grant.ts). */
export const MACHINE_GIT_GRANT_ROUTE = "/machine-git/grant";

const sessionFile = /^[0-9a-f-]{36}$/;

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
 * Writes this step's token (one file per chat, so chats sharing a VM keep
 * theirs), the helper and the config, and includes the config from the
 * agent user's global git config once. Everything is private to that user.
 */
export function machineGitSetupScript(input: {
	origin: string;
	sessionId: string;
	token: string;
}) {
	if (!sessionFile.test(input.sessionId))
		throw new Error("Invalid chat id for workspace git.");
	const token = quote(input.token);
	return `set -eu
umask 077
d="$HOME/${MACHINE_GIT_HOME_FOLDER}"
if [ -L "$d" ] || { [ -e "$d" ] && [ ! -O "$d" ]; }; then echo "${MACHINE_GIT_HOME_FOLDER} is not this user's directory" >&2; exit 1; fi
mkdir -p "$d/tokens"
chmod 700 "$d" "$d/tokens"
printf '%s' ${token} > "$d/tokens/.${input.sessionId}"
mv -f "$d/tokens/.${input.sessionId}" "$d/tokens/${input.sessionId}"
printf '%s' ${quote(machineGitCredentialHelper(input.origin))} > "$d/.credential-helper"
chmod 700 "$d/.credential-helper"
mv -f "$d/.credential-helper" "$d/credential-helper"
printf '%s' ${quote(machineGitConfig(input.origin))} > "$d/.config"
mv -f "$d/.config" "$d/config"
git config --global --get-all include.path 2>/dev/null | grep -qxF ${quote(MACHINE_GIT_INCLUDE)} ||
	git config --global --add include.path ${quote(MACHINE_GIT_INCLUDE)}`;
}

/**
 * Removes this chat's token at the end of its step, and the config with the
 * last token, so git between turns goes to github.com as before. Never fails.
 */
export function machineGitReleaseScript(sessionId: string) {
	if (!sessionFile.test(sessionId))
		throw new Error("Invalid chat id for workspace git.");
	return `d="$HOME/${MACHINE_GIT_HOME_FOLDER}"
rm -f "$d/tokens/${sessionId}"
[ -n "$(ls -A "$d/tokens" 2>/dev/null)" ] || rm -f "$d/config"
true`;
}

/** Shell run before any snapshot: every machine token and the config go, proven gone. */
export const SCRUB_MACHINE_GIT_CREDENTIAL = `d="$HOME/${MACHINE_GIT_HOME_FOLDER}"; rm -rf "$d/tokens" "$d/config" && test ! -e "$d/tokens"`;
