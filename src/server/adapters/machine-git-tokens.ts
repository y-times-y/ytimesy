import { database } from "./database";

/** The chat a machine token was put on the VM for. */
export type MachineGitChat = {
	userId: string;
	sessionId: string;
	projectId: string;
};

/** Who uses a token on the VM: the chat's agent step, or the user's terminal on that chat. */
export type MachineGitHolder = "step" | "terminal";

export type MachineGitTokenOwner = MachineGitChat & {
	holder: MachineGitHolder;
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
	async mint(input: {
		userId: string;
		sessionId: string;
		expiresAt: Date;
		holder?: MachineGitHolder;
	}) {
		const token = `ygm_${Array.from(
			crypto.getRandomValues(new Uint8Array(32)),
			(value) => value.toString(16).padStart(2, "0"),
		).join("")}`;
		await database().query(
			`with expired as (
			   delete from machine_git_token where user_id=$2 and expires_at < now() - interval '1 day'
			 )
			 insert into machine_git_token(token_hash,user_id,session_id,expires_at,holder) values($1,$2,$3,$4,$5)`,
			[
				await machineGitTokenHash(token),
				input.userId,
				input.sessionId,
				input.expiresAt.toISOString(),
				input.holder ?? "step",
			],
		);
		return token;
	},

	/** The live chat a token belongs to: not revoked, not expired, the chat not archived. */
	async owner(token: string): Promise<MachineGitTokenOwner | null> {
		if (!/^ygm_[a-f0-9]{64}$/.test(token)) return null;
		const result = await database().query<MachineGitTokenOwner>(
			`select t.user_id as "userId", t.session_id as "sessionId", s.project_id as "projectId", t.holder
			 from machine_git_token t
			 join agent_session s on s.id=t.session_id and s.user_id=t.user_id
			 where t.token_hash=$1 and t.revoked_at is null and t.expires_at > now()
			   and s.archived_at is null`,
			[await machineGitTokenHash(token)],
		);
		return result.rows[0] ?? null;
	},

	/** Moves an open token's expiry (a terminal still open); false when it is gone. */
	async extend(token: string, expiresAt: Date) {
		const result = await database().query(
			"update machine_git_token set expires_at=$2 where token_hash=$1 and revoked_at is null and expires_at > now() returning token_hash",
			[await machineGitTokenHash(token), expiresAt.toISOString()],
		);
		return result.rows.length === 1;
	},

	async revoke(token: string) {
		await database().query(
			"update machine_git_token set revoked_at=now() where token_hash=$1 and revoked_at is null",
			[await machineGitTokenHash(token)],
		);
	},

	/** Revokes every open step token of the chat, whichever step minted it; terminals keep theirs. */
	async revokeForSession(userId: string, sessionId: string) {
		await database().query(
			"update machine_git_token set revoked_at=now() where user_id=$1 and session_id=$2 and holder='step' and revoked_at is null",
			[userId, sessionId],
		);
	},
};
