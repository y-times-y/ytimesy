import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	commitCoAuthorTrailer,
	type PublicationAuthor,
} from "#/domain/publication";

// Verified against c5620054 in the product repository's history.
export const MANAGED_GIT_BOT = {
	name: "ytimesy-agent[bot]",
	email: "328807657+ytimesy-agent[bot]@users.noreply.github.com",
} as const;

export const MANAGED_GIT_TRAILER = commitCoAuthorTrailer(MANAGED_GIT_BOT);
export const MANAGED_PUSH_METADATA_FORMAT =
	"%an <%ae>%x09%cn <%ce>%n%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x0a)";
export const MANAGED_PUSH_REFUSED =
	"Push refused: an unpublished commit does not have the managed Git identity and Co-authored-by trailer required for publication. Keep the original branch. To publish its committed changes without rewriting it, follow docs/managed-git-recovery.md from the ytimesy repository.";
const identity = `${MANAGED_GIT_BOT.name} <${MANAGED_GIT_BOT.email}>`;
const name = quote(MANAGED_GIT_BOT.name);
const email = quote(MANAGED_GIT_BOT.email);

/** Bot as author and committer: internal refs and plumbing commits that are never pushed to a branch. */
export const MANAGED_GIT_ENV = `GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email}`;
export const MANAGED_GIT = `${MANAGED_GIT_ENV} git`;

const formatted = (who: PublicationAuthor) => `${who.name} <${who.email}>`;

/**
 * Who a published commit must name. The author is the signed-in user's own
 * GitHub account (githubCommitIdentity: the profile's email, or its id+login
 * noreply address), so GitHub counts the commit as their contribution. The
 * committer is the bot (or the user, when Git's own config committed) and the
 * bot is always credited with a Co-authored-by trailer. When the user's
 * GitHub identity is unknown the bot stays the author; it is never replaced
 * by a guessed identity.
 */
export function managedGitIdentity(human?: PublicationAuthor | null) {
	const author = human ?? MANAGED_GIT_BOT;
	const who = formatted(author);
	return {
		author,
		acceptedIdentities: [...new Set([`${who}\t${who}`, `${who}\t${identity}`])],
	};
}
/** The user as author and the bot as committer, for a commit made outside a configured checkout (a merge pushed to the chat's branch). */
export function managedMergeEnv(human?: PublicationAuthor | null) {
	const author = human ?? MANAGED_GIT_BOT;
	return `GIT_AUTHOR_NAME=${quote(author.name)} GIT_AUTHOR_EMAIL=${quote(author.email)} GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email}`;
}

type ManagedGitIdentity = ReturnType<typeof managedGitIdentity>;

function prepareCommitMessage(managed: ManagedGitIdentity) {
	const author = quote(`${formatted(managed.author)} `);
	const committer = quote(`${identity} `);
	return `#!/bin/sh
set -eu
case "$(git var GIT_AUTHOR_IDENT)" in
  ${author}*) ;;
  *) echo 'Managed Git identity required: the author must be the signed-in user. Remove identity overrides and retry.' >&2; exit 1 ;;
esac
case "$(git var GIT_COMMITTER_IDENT)" in
  ${author}*|${committer}*) ;;
  *) echo 'Managed Git identity required for the committer (the signed-in user or the ytimesy bot). Remove identity overrides and retry.' >&2; exit 1 ;;
esac
git -c trailer.ifexists=addIfDifferent -c trailer.ifmissing=add interpret-trailers --in-place --trailer ${quote(MANAGED_GIT_TRAILER)} -- "$1"
`;
}

function prePush(managed: ManagedGitIdentity) {
	return `#!/bin/sh
set -eu
pending=''
while read -r local_ref local_oid remote_ref remote_oid; do
  if [ -n "\${YTIMESY_CREATE_RECOVERY_REF:-}" ]; then
    if [ "$remote_ref" != "$YTIMESY_CREATE_RECOVERY_REF" ]; then
      echo 'Recovery push refused: unexpected destination ref.' >&2; exit 1
    fi
    case "$remote_oid" in *[!0]*) echo 'Recovery push refused: destination branch already exists.' >&2; exit 1 ;; esac
    case "$local_oid" in *[!0]*) ;; *) echo 'Recovery push refused: cannot delete a branch.' >&2; exit 1 ;; esac
  fi
  case "$local_oid" in *[!0]*) pending="$pending $local_oid" ;; esac
done
[ -n "$pending" ] || exit 0
scratch=$(mktemp -d "\${TMPDIR:-/tmp}/ytimesy-git-upstream.XXXXXXXX")
namespace="refs/ytimesy/push-\${scratch##*/}"
cleanup() {
  git for-each-ref --format='delete %(refname)' "$namespace/" | git update-ref --stdin >/dev/null
  rmdir "$scratch"
}
trap cleanup EXIT
git fetch --quiet --no-write-fetch-head --no-tags -- "$2" "refs/heads/*:$namespace/*"
for oid in $pending; do
  ${pushIdentityCheck("git", '"$oid"', '"--glob=$namespace/*"', 1, managed)}
done
`;
}

/** Only run for product-owned agent checkouts. Linked worktrees share the common Git directory. */
export function managedGitSetupCommand(
	directory: string,
	human?: PublicationAuthor | null,
) {
	return setupManagedGitForQuotedDirectory(quote(directory), human);
}

export function setupManagedGitForQuotedDirectory(
	directory: string,
	human?: PublicationAuthor | null,
) {
	const managed = managedGitIdentity(human);
	const git = `git -C ${directory}`;
	return `common=$(${git} rev-parse --path-format=absolute --git-common-dir) &&
mkdir -p "$common/ytimesy-hooks" &&
printf '%s' ${quote(prepareCommitMessage(managed))} > "$common/ytimesy-hooks/prepare-commit-msg" &&
printf '%s' ${quote(prePush(managed))} > "$common/ytimesy-hooks/pre-push" &&
chmod +x "$common/ytimesy-hooks/prepare-commit-msg" "$common/ytimesy-hooks/pre-push" &&
${git} config --local user.name ${quote(managed.author.name)} &&
${git} config --local user.email ${quote(managed.author.email)} &&
${git} config --local user.useConfigOnly true &&
${git} config --local core.hooksPath "$common/ytimesy-hooks"`;
}

export function hasManagedPushMetadata(
	metadata: string,
	human?: PublicationAuthor | null,
) {
	const [identities, ...coAuthors] = metadata.split("\n");
	return (
		managedGitIdentity(human).acceptedIdentities.includes(identities ?? "") &&
		coAuthors.includes(identity)
	);
}

/** Validate only commits not reachable from the fetched upstream refs, using raw (not mailmapped) identities. */
export function managedPushIdentityCheck(
	git: string,
	tip: string,
	upstream: string,
	failureCode = 1,
	human?: PublicationAuthor | null,
) {
	return pushIdentityCheck(
		git,
		quote(tip),
		quote(upstream),
		failureCode,
		managedGitIdentity(human),
	);
}

function pushIdentityCheck(
	git: string,
	tip: string,
	upstream: string,
	failureCode: number,
	managed: ManagedGitIdentity,
) {
	const accepted = managed.acceptedIdentities.map(quote).join("|");
	return `pending_commits=$(${git} --no-replace-objects rev-list ${tip} --not ${upstream}) || exit ${failureCode}
for pending_commit in $pending_commits; do
  metadata=$(${git} --no-replace-objects show -s --format=${quote(MANAGED_PUSH_METADATA_FORMAT)} "$pending_commit") || exit ${failureCode}
  case "$(printf '%s\\n' "$metadata" | head -n 1)" in ${accepted}) managed_identities=1 ;; *) managed_identities=0 ;; esac
  if [ "$managed_identities" != 1 ] ||
     ! printf '%s\\n' "$metadata" | grep -Fx -e ${quote(identity)} >/dev/null; then
    echo ${quote(MANAGED_PUSH_REFUSED)} >&2
    exit ${failureCode}
  fi
done`;
}
