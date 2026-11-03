import {
	GitProxyFailure,
	type GitProxyGrant,
} from "../../domain/github-git-proxy";
import { database } from "../adapters/database";
import { authorizedRepository, githubClient } from "../adapters/github";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import { githubAccessToken } from "../auth/github-connection";
import { timed } from "../services/step-timing";

/** Re-check current owner and GitHub access on every operation, including after disconnect. */
export async function authorizeGitProxy(grant: GitProxyGrant) {
	// The owner's row, their GitHub connection and the installation token are
	// independent reads: they run together, and the token is only returned
	// once every check passed.
	const userTokenRead = githubAccessToken(grant.userId).catch(() => {
		throw new GitProxyFailure("user-connection");
	});
	const installationTokenRead = timed("git:installationToken", () =>
		githubInstallationAccessToken(grant.installationId, {
			repositoryNames: [grant.name],
			contents: grant.access,
		}),
	).catch(() => {
		throw new GitProxyFailure("installation-token");
	});
	// A push also needs the user's own push permission; that read needs only
	// their token, so it runs beside the owner and repository checks.
	const pushAllowedRead =
		grant.access === "write"
			? userTokenRead.then((userToken) =>
					timed("git:reposGet", () =>
						githubClient(userToken).repos.get({
							owner: grant.owner,
							repo: grant.name,
						}),
					).then(
						(access) => Boolean(access.data.permissions?.push),
						() => {
							throw new GitProxyFailure("repository-access");
						},
					),
				)
			: Promise.resolve(true);
	// Settled here so a refusal before they are awaited is not unhandled.
	userTokenRead.catch(() => undefined);
	installationTokenRead.catch(() => undefined);
	pushAllowedRead.catch(() => undefined);
	const repository = (
		await database()
			.query<{ repositoryId: number }>(
				`select r.repository_id::float8 as "repositoryId"
		 from project_repository r join project p on p.id=r.project_id
		 where p.id=$1 and p.user_id=$2 and r.installation_id=$3 and r.full_name=$4`,
				[
					grant.projectId,
					grant.userId,
					grant.installationId,
					`${grant.owner}/${grant.name}`,
				],
			)
			.catch((cause: unknown) => {
				const message = cause instanceof Error ? cause.message : "";
				const code =
					cause instanceof Error && "code" in cause ? cause.code : null;
				const allowed = new Set([
					"ENOTFOUND",
					"ECONNREFUSED",
					"ECONNRESET",
					"ETIMEDOUT",
					"ENOENT",
					"ERR_TLS_CERT_ALTNAME_INVALID",
					"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
					"CERT_HAS_EXPIRED",
					"DEPTH_ZERO_SELF_SIGNED_CERT",
					"SELF_SIGNED_CERT_IN_CHAIN",
				]);
				console.warn("Git proxy database failed.", {
					databaseErrorType:
						cause instanceof Error &&
						["Error", "TypeError", "RangeError", "AggregateError"].includes(
							cause.name,
						)
							? cause.name
							: "other",
					databaseReason:
						cause instanceof Error && /timeout/i.test(cause.message)
							? "connect-timeout"
							: cause instanceof Error &&
									/cross.request|different request/i.test(cause.message)
								? "request-ownership"
								: cause instanceof Error &&
										/ssl|tls|certific/i.test(cause.message)
									? "tls"
									: cause instanceof Error &&
											/not implemented/i.test(cause.message)
										? "unsupported-runtime"
										: /terminated|closed/i.test(message)
											? "connection-closed"
											: /undefined|null/i.test(message)
												? "runtime-property"
												: /socket|stream/i.test(message)
													? "socket-runtime"
													: "unknown",
					databaseCode:
						typeof code === "string" &&
						(allowed.has(code) || /^[0-9A-Z]{5}$/.test(code))
							? code
							: "unknown",
				});
				throw new GitProxyFailure("database");
			})
	).rows[0];
	if (!repository) return null;
	const userToken = await userTokenRead;
	await timed("git:authorizedRepository", () =>
		authorizedRepository(
			userToken,
			grant.installationId,
			repository.repositoryId,
		),
	).catch(() => {
		throw new GitProxyFailure("repository-access");
	});
	if (!(await pushAllowedRead)) return null;
	return installationTokenRead;
}

/** Spends a push grant once; false when it was already used. */
export async function claimGitProxyGrant(nonce: string, expiresAt: number) {
	if (!/^[a-f0-9]{32}$/.test(nonce) || !Number.isFinite(expiresAt))
		return false;
	const claimed = await database()
		.query(
			`with expired as (
			   delete from git_proxy_grant_claim where expires_at < now() - interval '5 minutes'
			 )
			 insert into git_proxy_grant_claim(nonce, expires_at)
			 values ($1, to_timestamp($2::float8 / 1000))
			 on conflict (nonce) do nothing
			 returning nonce`,
			[nonce, expiresAt],
		)
		.catch(() => {
			throw new GitProxyFailure("grant-claim");
		});
	return claimed.rows.length === 1;
}
