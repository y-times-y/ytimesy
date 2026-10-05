import { randomUUID } from "node:crypto";
import {
	checkpointObjectPrefix,
	removeCheckpoint,
} from "../src/server/adapters/checkpoints/storage";
import {
	archiveModelContext,
	readModelContextArchive,
	searchModelContextArchives,
} from "../src/server/adapters/context-archives";
import { database } from "../src/server/adapters/database";

/** Uses one existing chat's authorized storage namespace; deletes only this proof's new object. */
async function proveContextHistory() {
	const db = database();
	const { rows } = await db.query<{ id: string; user_id: string }>(
		"select id,user_id from agent_session order by created_at desc limit 1",
	);
	const session = rows[0];
	if (!session) throw new Error("An existing development chat is required.");
	const marker = `archive-proof-${randomUUID()}`;
	const messages = [
		{
			role: "user" as const,
			content: "Check branch isolation before continuing.",
		},
		{
			role: "assistant" as const,
			content: [
				{
					type: "text" as const,
					text: `Verified src/branches.ts implements isolation: ${marker}`,
				},
				{
					type: "reasoning" as const,
					text: "",
					providerOptions: {
						openai: { reasoningEncryptedContent: "fixture-opaque-state" },
					},
				},
			],
		},
	];
	const reference = await archiveModelContext(
		session.user_id,
		session.id,
		messages,
	);
	try {
		const signal = AbortSignal.timeout(60_000);
		let offset: number | null = 0;
		let messageOffset = 0;
		let found = false;
		for (let page = 0; page < 100 && offset !== null; page++) {
			const result = await searchModelContextArchives(
				session.user_id,
				session.id,
				`missing-${marker}`,
				offset,
				signal,
				messageOffset,
				[marker],
			);
			if (
				result.matches.some(
					(match) =>
						match.reference === reference &&
						match.excerpt.includes(marker) &&
						match.matchedQuery === marker &&
						match.context.some(
							(neighbor) =>
								neighbor.messageIndex === 0 &&
								neighbor.excerpt.includes("branch isolation"),
						),
				)
			) {
				found = true;
				break;
			}
			offset = result.nextOffset;
			messageOffset = result.nextMessageOffset;
		}
		if (!found)
			throw new Error("Live archive search did not find its evidence.");
		const restored = await readModelContextArchive(
			session.user_id,
			session.id,
			reference,
		);
		if (JSON.stringify(restored) !== JSON.stringify(messages))
			throw new Error("Canonical archive roundtrip failed.");
		let blocked = false;
		try {
			await readModelContextArchive(session.user_id, randomUUID(), reference);
		} catch {
			blocked = true;
		}
		if (!blocked) throw new Error("Cross-chat archive lookup was not blocked.");
		console.log(
			"PASS: live encrypted archive, searchable evidence, canonical retrieval, cross-chat isolation.",
		);
	} finally {
		await removeCheckpoint(
			`${checkpointObjectPrefix(session.user_id, session.id)}${reference}.enc`,
		);
		await db.end();
		console.log(
			"Proof archive removed; existing chats and archives untouched.",
		);
	}
}

await proveContextHistory();
