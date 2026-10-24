/**
 * The paths a git index (`.git/index`) tracks, in index order (sorted, as
 * `git ls-files` prints them). Files reads it from a sleeping machine's disk,
 * where git itself cannot run. isomorphic-git's reader is internal and only
 * reads version 2, so this one reads versions 2-4 for paths alone.
 *
 * Returns null when the bytes are not a git index this can read.
 */
export function gitIndexPaths(bytes: Uint8Array, limit = Infinity) {
	if (bytes.length < 12) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "DIRC") return null;
	const version = view.getUint32(4);
	if (version < 2 || version > 4) return null;
	const count = view.getUint32(8);
	const decoder = new TextDecoder();
	const paths: string[] = [];
	let offset = 12;
	let previous: Uint8Array = new Uint8Array(0);
	for (let index = 0; index < count && paths.length < limit; index++) {
		const start = offset;
		// ctime, mtime, dev, ino, mode, uid, gid, size, object id.
		offset += 60;
		if (offset + 2 > bytes.length) return null;
		const flags = view.getUint16(offset);
		offset += 2;
		if (version >= 3 && flags & 0x4000) offset += 2;
		let name: Uint8Array;
		if (version === 4) {
			// The name drops this many trailing bytes of the previous one.
			let byte = bytes[offset++] ?? 0;
			let strip = byte & 0x7f;
			while (byte & 0x80) {
				byte = bytes[offset++] ?? 0;
				strip = ((strip + 1) << 7) | (byte & 0x7f);
			}
			const end = bytes.indexOf(0, offset);
			if (end < 0 || strip > previous.length) return null;
			const kept = previous.subarray(0, previous.length - strip);
			name = new Uint8Array(kept.length + end - offset);
			name.set(kept);
			name.set(bytes.subarray(offset, end), kept.length);
			offset = end + 1;
		} else {
			const end = bytes.indexOf(0, offset);
			if (end < 0) return null;
			name = bytes.subarray(offset, end);
			// Entries are NUL-padded to a multiple of eight bytes.
			offset = start + Math.ceil((end - start + 1) / 8) * 8;
		}
		previous = name;
		const path = decoder.decode(name);
		// Conflicted paths repeat once per stage; sparse directories end in "/".
		if (path !== paths.at(-1) && !path.endsWith("/")) paths.push(path);
	}
	return paths;
}
