import { createHash, randomBytes } from "node:crypto";
import { database } from "../adapters/database";
import { exchangeGithubToken, githubClient } from "../adapters/github";
import { serverConfig } from "../config";
import { githubCredentials, seal, unseal } from "./token-vault";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const callbackUrl = () => `${serverConfig().APP_URL}/api/github/callback`;
export async function startGithubConnection(userId: string) {
	const state = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	await database().query(
		"delete from github_oauth_state where expires_at < now()",
	);
	await database().query(
		"insert into github_oauth_state(state_hash,user_id,encrypted_verifier,expires_at) values($1,$2,$3,now()+interval '10 minutes')",
		[hash(state), userId, await seal(verifier)],
	);
	const url = new URL("https://github.com/login/oauth/authorize");
	url.search = new URLSearchParams({
		client_id: serverConfig().GITHUB_APP_CLIENT_ID,
		redirect_uri: callbackUrl(),
		state,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}
export async function finishGithubConnection(
	userId: string,
	state: string,
	code: string,
) {
	const consumed = await database().query(
		"delete from github_oauth_state where state_hash=$1 and user_id=$2 and expires_at>now() returning encrypted_verifier",
		[hash(state), userId],
	);
	if (!consumed.rowCount)
		throw new Error("GitHub connection expired. Start again.");
	const credentials = await exchangeGithubToken({
		code,
		redirect_uri: callbackUrl(),
		code_verifier: await unseal(consumed.rows[0].encrypted_verifier),
	});
	const profile = await githubClient(
		credentials.accessToken,
	).users.getAuthenticated();
	const account = await database().query(
		'select "accountId" from auth_account where "userId"=$1 and "providerId"=\'github\'',
		[userId],
	);
	if (account.rows[0]?.accountId !== String(profile.data.id))
		throw new Error("Connect the same GitHub account you used to sign in.");
	await database().query(
		"insert into github_connection(user_id,github_user_id,encrypted_credentials) values($1,$2,$3) on conflict(user_id) do update set github_user_id=excluded.github_user_id,encrypted_credentials=excluded.encrypted_credentials,updated_at=now()",
		[userId, String(profile.data.id), await seal(JSON.stringify(credentials))],
	);
}
/** Row locking serializes refresh-token rotation across web processes. */
export async function githubAccessToken(userId: string) {
	const connection = await database().connect();
	try {
		await connection.query("begin");
		const result = await connection.query(
			"select encrypted_credentials from github_connection where user_id=$1 for update",
			[userId],
		);
		if (!result.rowCount)
			throw new Response("Connect GitHub to choose repositories.", {
				status: 409,
			});
		let credentials = githubCredentials.parse(
			JSON.parse(await unseal(result.rows[0].encrypted_credentials)),
		);
		if (credentials.expiresAt && credentials.expiresAt < Date.now() + 60000) {
			if (!credentials.refreshToken)
				throw new Response("Reconnect GitHub.", { status: 409 });
			credentials = await exchangeGithubToken({
				grant_type: "refresh_token",
				refresh_token: credentials.refreshToken,
			});
			await connection.query(
				"update github_connection set encrypted_credentials=$2,updated_at=now() where user_id=$1",
				[userId, await seal(JSON.stringify(credentials))],
			);
		}
		await connection.query("commit");
		return credentials.accessToken;
	} catch (error) {
		await connection.query("rollback");
		throw error;
	} finally {
		connection.release();
	}
}
