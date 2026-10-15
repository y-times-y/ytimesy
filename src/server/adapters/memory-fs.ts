/**
 * The small promise file system isomorphic-git needs, held in memory. Memory
 * repos are a few hundred kilobytes of Markdown; a Worker has no disk.
 */
export class InMemoryFs {
	private readonly files = new Map<string, Uint8Array>();
	private readonly directories = new Set<string>(["/"]);

	readonly promises = {
		readFile: async (path: string, options?: unknown) => {
			const data = this.files.get(normalize(path));
			if (!data) throw fsError("ENOENT", path);
			const encoding =
				typeof options === "string"
					? options
					: (options as { encoding?: string } | undefined)?.encoding;
			return encoding ? new TextDecoder().decode(data) : Buffer.from(data);
		},
		writeFile: async (path: string, data: string | Uint8Array) => {
			const target = normalize(path);
			if (!this.directories.has(parent(target))) throw fsError("ENOENT", path);
			if (this.directories.has(target)) throw fsError("EISDIR", path);
			this.files.set(
				target,
				typeof data === "string"
					? new TextEncoder().encode(data)
					: new Uint8Array(data),
			);
		},
		unlink: async (path: string) => {
			if (!this.files.delete(normalize(path))) throw fsError("ENOENT", path);
		},
		readdir: async (path: string) => {
			const target = normalize(path);
			if (!this.directories.has(target))
				throw fsError(this.files.has(target) ? "ENOTDIR" : "ENOENT", path);
			const prefix = target === "/" ? "/" : `${target}/`;
			const names = new Set<string>();
			for (const entry of [...this.files.keys(), ...this.directories])
				if (entry !== target && entry.startsWith(prefix))
					names.add(entry.slice(prefix.length).split("/")[0]);
			return [...names];
		},
		mkdir: async (path: string) => {
			const target = normalize(path);
			if (this.directories.has(target) || this.files.has(target))
				throw fsError("EEXIST", path);
			if (!this.directories.has(parent(target))) throw fsError("ENOENT", path);
			this.directories.add(target);
		},
		rmdir: async (path: string) => {
			const target = normalize(path);
			if (!this.directories.has(target)) throw fsError("ENOENT", path);
			if ((await this.promises.readdir(target)).length)
				throw fsError("ENOTEMPTY", path);
			this.directories.delete(target);
		},
		stat: async (path: string) => this.stat(path),
		lstat: async (path: string) => this.stat(path),
		readlink: async (path: string) => {
			throw fsError("ENOENT", path);
		},
		symlink: async (_target: string, path: string) => {
			throw fsError("EPERM", path);
		},
		chmod: async () => {},
	};

	private stat(path: string) {
		const target = normalize(path);
		const file = this.files.get(target);
		const directory = this.directories.has(target);
		if (!file && !directory) throw fsError("ENOENT", path);
		return {
			type: directory ? "dir" : "file",
			mode: directory ? 0o40755 : 0o100644,
			size: file?.byteLength ?? 0,
			ino: 0,
			dev: 0,
			uid: 0,
			gid: 0,
			mtimeMs: 0,
			ctimeMs: 0,
			isFile: () => !directory,
			isDirectory: () => directory,
			isSymbolicLink: () => false,
		};
	}
}

function normalize(path: string) {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

function parent(path: string) {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

function fsError(code: string, path: string) {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}
