import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { checkpointObjectPrefix } from "../../src/server/adapters/checkpoints/storage";
import type { ContextArchiveStorage } from "../../src/server/adapters/context-archives";

/** Private pilot storage only. The ephemeral encryption key never enters files or guests. */
export function localContextArchives(
	directory: string,
	owner: string,
	session: string,
) {
	const key = randomBytes(32).toString("hex");
	const prefix = checkpointObjectPrefix(owner, session);
	const owned = (user: string, chat: string) => {
		if (user !== owner || chat !== session)
			throw new Error("Archive ownership mismatch.");
	};
	const filename = (path: string) => {
		if (!path.startsWith(prefix))
			throw new Error("Archive ownership mismatch.");
		const name = path.slice(prefix.length);
		if (!/^context-[0-9a-f-]{36}\.enc$/.test(name))
			throw new Error("Invalid local archive reference.");
		return join(directory, name);
	};
	const storage: ContextArchiveStorage = {
		async uploadCheckpoint(user, chat, revision, payload) {
			owned(user, chat);
			if (Buffer.byteLength(payload) > 20 * 1024 * 1024)
				throw new Error("Archive exceeds safety limit.");
			const path = `${prefix}${revision}.enc`;
			const target = filename(path);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(target, await symmetricEncrypt({ key, data: payload }), {
				flag: "wx",
				mode: 0o600,
			});
			return path;
		},
		async downloadCheckpoint(user, chat, path) {
			owned(user, chat);
			return symmetricDecrypt({
				key,
				data: await readFile(filename(path), "utf8"),
			});
		},
		async listContextArchives(user, chat, offset = 0, limit = 3) {
			owned(user, chat);
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 10
			)
				throw new Error("Invalid archive page.");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			return (await readdir(directory))
				.filter((name) => /^context-[0-9a-f-]{36}\.enc$/.test(name))
				.sort()
				.slice(offset, offset + limit)
				.map((name) => name.slice(0, -4));
		},
	};
	return {
		storage,
		async close() {
			for (const name of await readdir(directory).catch(() => [])) {
				if (/^context-[0-9a-f-]{36}\.enc$/.test(name))
					await unlink(join(directory, name));
			}
		},
	};
}
