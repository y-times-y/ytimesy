import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { searchContextMessages } from "#/domain/context-history-search";
import {
	checkpointObjectPrefix,
	downloadCheckpoint,
	listContextArchives,
	uploadCheckpoint,
} from "./checkpoints/storage";

export const contextArchiveReference = z
	.string()
	.regex(/^context-[0-9a-f-]{36}$/);

export type ContextArchiveStorage = {
	uploadCheckpoint: typeof uploadCheckpoint;
	downloadCheckpoint: typeof downloadCheckpoint;
	listContextArchives: typeof listContextArchives;
};
const remoteStorage: ContextArchiveStorage = {
	uploadCheckpoint,
	downloadCheckpoint,
	listContextArchives,
};

export async function archiveModelContext(
	userId: string,
	sessionId: string,
	messages: ModelMessage[],
	storage: ContextArchiveStorage = remoteStorage,
) {
	const reference = `context-${randomUUID()}`;
	await storage.uploadCheckpoint(
		userId,
		sessionId,
		reference,
		JSON.stringify({ version: 1, messages }),
	);
	return reference;
}

/** Search one bounded page; callers can retrieve exact originals using the returned pointers. */
export async function searchModelContextArchives(
	userId: string,
	sessionId: string,
	query: string,
	offset: number,
	signal: AbortSignal,
	messageOffset = 0,
	alternativeQueries: string[] = [],
	storage: ContextArchiveStorage = remoteStorage,
) {
	z.string().trim().min(1).max(200).parse(query);
	z.array(z.string().trim().min(1).max(200)).max(4).parse(alternativeQueries);
	z.number().int().min(0).parse(messageOffset);
	signal.throwIfAborted();
	const references = await storage.listContextArchives(
		userId,
		sessionId,
		offset,
		3,
	);
	const candidates = [];
	for (const reference of references) {
		signal.throwIfAborted();
		const messages = await readModelContextArchive(
			userId,
			sessionId,
			reference,
			storage,
		);
		signal.throwIfAborted();
		for (const match of searchContextMessages(
			messages,
			query,
			alternativeQueries,
		)) {
			candidates.push({ reference, ...match });
		}
	}
	candidates.sort(
		(a, b) =>
			b.score - a.score ||
			a.reference.localeCompare(b.reference) ||
			a.messageIndex - b.messageIndex,
	);
	const matches = candidates.slice(messageOffset, messageOffset + 10);
	if (messageOffset + matches.length < candidates.length)
		return {
			matches,
			nextOffset: offset,
			nextMessageOffset: messageOffset + matches.length,
		};
	return {
		matches,
		nextOffset: references.length === 3 ? offset + 3 : null,
		nextMessageOffset: 0,
	};
}

/** The current authorized chat supplies the scope; a model cannot choose another owner or chat. */
export async function readModelContextArchive(
	userId: string,
	sessionId: string,
	reference: string,
	storage: ContextArchiveStorage = remoteStorage,
): Promise<ModelMessage[]> {
	contextArchiveReference.parse(reference);
	const payload = await storage.downloadCheckpoint(
		userId,
		sessionId,
		`${checkpointObjectPrefix(userId, sessionId)}${reference}.enc`,
	);
	const parsed = JSON.parse(payload);
	if (parsed.version !== 1 || !Array.isArray(parsed.messages))
		throw new Error("Invalid context archive.");
	return parsed.messages;
}
