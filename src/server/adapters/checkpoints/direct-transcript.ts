import { randomBytes } from "node:crypto";
import {
	DIRECT_HEADER_READ_BYTES,
	DIRECT_TRANSCRIPT_MAGIC,
	DIRECT_TRANSCRIPT_SUFFIX,
	type DirectTranscriptStore,
} from "#/domain/direct-transcript";
import { seal, unseal } from "#/server/auth/token-vault";
import { presignedR2Url, r2Configuration } from "./r2";
import { checkpointObjectPrefix } from "./storage";

/** How long the VM has to use a presigned URL; one upload or download takes seconds. */
const URL_SECONDS = 15 * 60;
const HEADER_READ_MS = 15_000;
const CLAUDE_SESSION_ID = /^[0-9a-f-]{36}$/;

/** The wrapped data key is bound to its user and exact object path. */
const keyBinding = (userId: string, path: string) => ({
	purpose: `claude-transcript-key:${path}`,
	userId,
});

/** The object path: this chat's private prefix and the Claude session it saves. */
export function directTranscriptPath(
	userId: string,
	sessionId: string,
	claudeSessionId: string,
) {
	if (!CLAUDE_SESSION_ID.test(claudeSessionId))
		throw new Error("Invalid Claude Code session id.");
	return `${checkpointObjectPrefix(userId, sessionId)}claude-code-${claudeSessionId}${DIRECT_TRANSCRIPT_SUFFIX}`;
}

function configuration() {
	// Isolated evaluations keep their checkpoints on local disk, never in shared storage.
	if (
		process.env.YTIMESY_EVALUATION_CHECKPOINT_DIR &&
		process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1"
	)
		return null;
	try {
		return r2Configuration();
	} catch {
		return null;
	}
}

/**
 * The first lines of the stored object (magic and wrapped key), read with a
 * ranged request and capped, so a server that ignores the range cannot make
 * the Durable Object read the whole file.
 */
async function readHeader(url: string): Promise<string | null> {
	const response = await fetch(url, {
		headers: { range: `bytes=0-${DIRECT_HEADER_READ_BYTES - 1}` },
		redirect: "manual",
		signal: AbortSignal.timeout(HEADER_READ_MS),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < DIRECT_HEADER_READ_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
	}
	await reader.cancel().catch(() => undefined);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const [magic, header, rest] = new TextDecoder()
		.decode(bytes.subarray(0, DIRECT_HEADER_READ_BYTES))
		.split("\n", 3);
	return magic === DIRECT_TRANSCRIPT_MAGIC && header && rest !== undefined
		? header
		: null;
}

/**
 * The chat's side of a direct transcript transfer, or undefined when private
 * R2 storage is not configured (evaluations, local development), where the
 * caller keeps its inline limit.
 */
export function directTranscriptStore(
	userId: string,
	sessionId: string,
): DirectTranscriptStore | undefined {
	const config = configuration();
	if (!config) return undefined;
	return {
		prepareUpload: async (claudeSessionId) => {
			const path = directTranscriptPath(userId, sessionId, claudeSessionId);
			const dataKey = randomBytes(32).toString("base64");
			return {
				path,
				config: {
					url: presignedR2Url({
						config,
						method: "PUT",
						key: path,
						expiresSeconds: URL_SECONDS,
					}),
					dataKey,
					path,
					header: await seal(dataKey, keyBinding(userId, path)),
				},
			};
		},
		prepareDownload: async (path) => {
			if (
				!path.startsWith(checkpointObjectPrefix(userId, sessionId)) ||
				!path.endsWith(DIRECT_TRANSCRIPT_SUFFIX) ||
				path.includes("..")
			)
				throw new Error("Checkpoint ownership mismatch.");
			const header = await readHeader(
				presignedR2Url({
					config,
					method: "GET",
					key: path,
					expiresSeconds: URL_SECONDS,
				}),
			);
			if (!header) return null;
			return {
				config: {
					url: presignedR2Url({
						config,
						method: "GET",
						key: path,
						expiresSeconds: URL_SECONDS,
					}),
					dataKey: await unseal(header, keyBinding(userId, path)),
					path,
				},
			};
		},
	};
}
