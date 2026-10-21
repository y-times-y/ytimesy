import { database } from "./database";

/**
 * Ids of memory repo tokens put on a builder's VM (never the tokens), so a
 * step in any isolate can revoke what an earlier step minted.
 */
export type MemoryVmTokenLedger = {
	record(input: {
		tokenId: string;
		userId: string;
		sessionId: string;
		repo: string;
		expiresAt: Date;
	}): Promise<void>;
	/** Tokens of this chat not yet revoked and not yet expired. */
	open(userId: string, sessionId: string): Promise<string[]>;
	revoked(userId: string, tokenIds: readonly string[]): Promise<void>;
};

export const memoryVmTokens: MemoryVmTokenLedger = {
	async record(input) {
		await database().query(
			"insert into memory_vm_token(token_id,user_id,session_id,repo,expires_at) values($1,$2,$3,$4,$5) on conflict(token_id) do nothing",
			[
				input.tokenId,
				input.userId,
				input.sessionId,
				input.repo,
				input.expiresAt.toISOString(),
			],
		);
	},
	async open(userId, sessionId) {
		const result = await database().query<{ token_id: string }>(
			"select token_id from memory_vm_token where user_id=$1 and session_id=$2 and revoked_at is null and expires_at > now() limit 50",
			[userId, sessionId],
		);
		return result.rows.map((row) => row.token_id);
	},
	async revoked(userId, tokenIds) {
		if (!tokenIds.length) return;
		// Expired rows of this user go too: they are useless.
		await database().query(
			"with done as (update memory_vm_token set revoked_at=now() where user_id=$1 and token_id=any($2::text[]) and revoked_at is null) delete from memory_vm_token where user_id=$1 and expires_at < now() - interval '1 day'",
			[userId, tokenIds],
		);
	},
};
