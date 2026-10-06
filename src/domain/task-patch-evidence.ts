export type TaskPatchIdentity = {
	readonly taskId: string;
	readonly sha256: string;
	readonly base: string;
};

export function assertPatchIdentity(patch: TaskPatchIdentity) {
	if (
		!patch.taskId ||
		!/^[a-f0-9]{64}$/.test(patch.sha256) ||
		!/^[a-f0-9]{40,64}$/.test(patch.base)
	)
		throw new Error("Invalid task patch identity.");
}

export type TaskImportEvidence = TaskPatchIdentity & {
	readonly destinationId: string;
};

/** A final checkout must contain all writers' accepted work, directly or transitively. */
export function integratedTaskWriter<T extends { readonly id: string }>(
	writers: readonly T[],
	imports: readonly TaskImportEvidence[],
	reviews: ReadonlyMap<string, TaskPatchIdentity>,
) {
	if (!writers.length) throw new Error("No writable result is available.");
	const ids = new Set(writers.map((writer) => writer.id));
	const edges = new Map<string, Set<string>>();
	for (const entry of imports) {
		const review = reviews.get(entry.taskId);
		if (
			!ids.has(entry.destinationId) ||
			!review ||
			review.sha256 !== entry.sha256 ||
			review.base !== entry.base
		)
			continue;
		const sources = edges.get(entry.destinationId) ?? new Set<string>();
		sources.add(entry.taskId);
		edges.set(entry.destinationId, sources);
	}
	const candidates = writers.filter((writer) => {
		const covered = new Set<string>();
		const visit = (id: string) => {
			if (covered.has(id)) return;
			covered.add(id);
			for (const source of edges.get(id) ?? []) visit(source);
		};
		visit(writer.id);
		return writers.every((source) => covered.has(source.id));
	});
	if (candidates.length !== 1)
		throw new Error(
			"Require one reviewed integration checkout covering every writable task.",
		);
	return candidates[0];
}
