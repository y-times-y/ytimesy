import { database } from "./database";

/** The chat a machine token was put on the VM for. */
export type MachineGitTokenOwner = {
	userId: string;
	sessionId: string;
	projectId: string;
};

export async function machineGitTokenHash(token: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Tokens plain git on a chat's VM presents to ask for git grants. Only their
 * SHA-256 is stored, so a step in any isolate can check or revoke what an
 * earlier step minted; the token itself lives only on the VM.
 */
export const machineGitTokens = {
	async mint(input: { userId: string; sessionId: string; expiresAt: Date }) {
		const token = `ygm_${Array.from(
			crypto.getRandomValues(new Uint8Array(32)),
			(value) => value.toString(16).padStart(2, "0"),
		).join("")}`;
		await database().query(
			`with expired as (
			   delete from machine_git_token where user_id=$2 and expires_at < now() - interval '1 day'
			 )
			 insert into machine_git_token(token_hash,user_id,session_id,expires_at) values($1,$2,$3,$4)`,
			[
				await machineGitTokenHash(token),
				input.userId,
				input.sessionId,
				input.expiresAt.toISOString(),
			],
		);
		return token;
	},

	/** The live chat a token belongs to: not revoked, not expired, the chat not archived. */
	async owner(token: string): Promise<MachineGitTokenOwner | null> {
		if (!/^ygm_[a-f0-9]{64}$/.test(token)) return null;
		const result = await database().query<MachineGitTokenOwner>(
			`select t.user_id as "userId", t.session_id as "sessionId", s.project_id as "projectId"
			 from machine_git_token t
			 join agent_session s on s.id=t.session_id and s.user_id=t.user_id
			 where t.token_hash=$1 and t.revoked_at is null and t.expires_at > now()
			   and s.archived_at is null`,
			[await machineGitTokenHash(token)],
		);
		return result.rows[0] ?? null;
	},

	/** Revokes every open token of the chat, whichever step minted it. */
	async revokeForSession(userId: string, sessionId: string) {
		await database().query(
			"update machine_git_token set revoked_at=now() where user_id=$1 and session_id=$2 and revoked_at is null",
			[userId, sessionId],
		);
	},
};
