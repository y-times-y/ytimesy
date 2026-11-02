// The rehearsal's memory: an in-process Artifacts namespace holding each
// seeded user's memory repo (one commit, read through the real adapter), and
// a deterministic stand-in for the Workers AI embedding model, so the real
// read side (project rules, read hook) runs. No Git remote: the builder's
// ~/memory clone cannot start, as on a machine without one.
import type { MemoryFiles } from "../../src/domain/memory-repo";
import { registerMemoryEmbeddings } from "../../src/server/adapters/memory-embeddings";
import {
	type ArtifactsNamespace,
	registerMemoryRepos,
} from "../../src/server/adapters/memory-repos";

const repos = new Map<string, MemoryFiles>();
const COMMIT = "rehearsal-commit";
const TREE = "rehearsal-tree";

function notFound(name: string) {
	return Object.assign(new Error(`No memory repo ${name}.`), {
		code: "NOT_FOUND",
	});
}

const namespace: ArtifactsNamespace = {
	async create() {
		throw new Error("The rehearsal creates no memory repos.");
	},
	async delete(name) {
		return repos.delete(name);
	},
	async get(name) {
		const files = repos.get(name);
		if (!files) throw notFound(name);
		const commit = {
			hash: COMMIT,
			treeHash: TREE,
			message: "Seed the rehearsal's memory",
			parents: [],
			committedAt: Date.now(),
		};
		return {
			async info() {
				return { remote: `https://memory.rehearsal.invalid/${name}.git` };
			},
			async createToken() {
				throw new Error("The rehearsal's memory repo has no Git remote.");
			},
			async log() {
				return [commit];
			},
			async readCommit(hash) {
				return hash === COMMIT ? commit : null;
			},
			async readTree(hash) {
				return hash === TREE
					? Object.keys(files).map((path) => ({
							name: path,
							hash: `blob:${path}`,
							type: "blob",
						}))
					: null;
			},
			async readBlob(hash) {
				const content = files[hash.replace(/^blob:/, "")];
				return content === undefined ? null : new Blob([content]);
			},
		};
	},
};

/** Words hashed into a small normalized vector: similar text, similar vector. */
function vector(text: string) {
	const out = new Array<number>(64).fill(0);
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		let hash = 0;
		for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
		out[hash % out.length] += 1;
	}
	const norm = Math.hypot(...out) || 1;
	return out.map((value) => value / norm);
}

export function registerRehearsalMemory() {
	registerMemoryRepos(namespace);
	registerMemoryEmbeddings({
		async run(_model, input) {
			// The reranker: the same vectors' cosine as relevance.
			if ("query" in input) {
				const query = vector(input.query);
				return {
					response: input.contexts.map((context, id) => ({
						id,
						score: vector(context.text).reduce(
							(sum, value, index) => sum + value * query[index],
							0,
						),
					})),
				};
			}
			return {
				data: [...(input.queries ?? []), ...(input.documents ?? [])].map(
					vector,
				),
			};
		},
	});
}

/** The user's memory repo (`memory-<user>`), as the user's chats read it. */
export function seedRehearsalMemory(repo: string, files: MemoryFiles) {
	repos.set(repo, files);
}
