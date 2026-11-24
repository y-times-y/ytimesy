import { posixShellQuoted as quote } from "#/domain/posix-command";
import { commitCoAuthorTrailer } from "#/domain/publication";

// Verified against c5620054 in the product repository's history.
export const MANAGED_GIT_BOT = {
	name: "ytimesy-agent[bot]",
	email: "328807657+ytimesy-agent[bot]@users.noreply.github.com",
} as const;

export const MANAGED_GIT_TRAILER = commitCoAuthorTrailer(MANAGED_GIT_BOT);
export const MANAGED_PUSH_METADATA_FORMAT =
	"%an <%ae>%x09%cn <%ce>%n%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x0a)";
export const MANAGED_PUSH_REFUSED =
	"Push refused: an unpublished commit does not have the managed Git identity and Co-authored-by trailer required for publication. Keep the original branch and apply its changes as new commits on a fresh managed branch based on a published branch.";
const identity = `${MANAGED_GIT_BOT.name} <${MANAGED_GIT_BOT.email}>`;
const bothIdentities = `${identity}	${identity}`;
const name = quote(MANAGED_GIT_BOT.name);
const email = quote(MANAGED_GIT_BOT.email);

export const MANAGED_GIT_ENV = `GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email}`;
export const MANAGED_GIT = `${MANAGED_GIT_ENV} git`;

const prepareCommitMessage = `#!/bin/sh
set -eu
for role in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do
  case "$(git var "$role")" in
    ${quote(`${identity} `)}*) ;;
    *) echo 'Managed Git identity required for both author and committer. Remove identity overrides and retry.' >&2; exit 1 ;;
  esac
done
git -c trailer.ifexists=addIfDifferent -c trailer.ifmissing=add interpret-trailers --in-place --trailer ${quote(MANAGED_GIT_TRAILER)} -- "$1"
`;

const prePush = `#!/bin/sh
set -eu
pending=''
while read -r local_ref local_oid remote_ref remote_oid; do
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
  ${pushIdentityCheck("git", '"$oid"', '"--glob=$namespace/*"', 1)}
done
`;

/** Only run for product-owned agent checkouts. Linked worktrees share the common Git directory. */
export function managedGitSetupCommand(directory: string) {
	return setupManagedGitForQuotedDirectory(quote(directory));
}

export function setupManagedGitForQuotedDirectory(directory: string) {
	const git = `git -C ${directory}`;
	return `common=$(${git} rev-parse --path-format=absolute --git-common-dir) &&
mkdir -p "$common/ytimesy-hooks" &&
printf '%s' ${quote(prepareCommitMessage)} > "$common/ytimesy-hooks/prepare-commit-msg" &&
printf '%s' ${quote(prePush)} > "$common/ytimesy-hooks/pre-push" &&
chmod +x "$common/ytimesy-hooks/prepare-commit-msg" "$common/ytimesy-hooks/pre-push" &&
${git} config --local user.name ${name} &&
${git} config --local user.email ${email} &&
${git} config --local user.useConfigOnly true &&
${git} config --local core.hooksPath "$common/ytimesy-hooks"`;
}

export function hasManagedPushMetadata(metadata: string) {
	const [identities, ...coAuthors] = metadata.split("\n");
	return identities === bothIdentities && coAuthors.includes(identity);
}

/** Validate only commits not reachable from the fetched upstream refs, using raw (not mailmapped) identities. */
export function managedPushIdentityCheck(
	git: string,
	tip: string,
	upstream: string,
	failureCode = 1,
) {
	return pushIdentityCheck(git, quote(tip), quote(upstream), failureCode);
}

function pushIdentityCheck(
	git: string,
	tip: string,
	upstream: string,
	failureCode: number,
) {
	return `pending_commits=$(${git} --no-replace-objects rev-list ${tip} --not ${upstream}) || exit ${failureCode}
for pending_commit in $pending_commits; do
  metadata=$(${git} --no-replace-objects show -s --format=${quote(MANAGED_PUSH_METADATA_FORMAT)} "$pending_commit") || exit ${failureCode}
  if [ "$(printf '%s\\n' "$metadata" | head -n 1)" != ${quote(bothIdentities)} ] ||
     ! printf '%s\\n' "$metadata" | grep -Fx -e ${quote(identity)} >/dev/null; then
    echo ${quote(MANAGED_PUSH_REFUSED)} >&2
    exit ${failureCode}
  fi
done`;
}
