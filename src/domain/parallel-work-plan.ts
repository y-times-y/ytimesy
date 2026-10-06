import { z } from "zod";

const ownedPath = z
	.string()
	.min(1)
	.max(500)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!path.includes("*") &&
			!path
				.split("/")
				.some((part) => part === ".." || part === ".git" || part === "."),
	);

export const parallelWorkPlan = z.object({
	tasks: z
		.array(
			z.object({
				id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
				objective: z.string().min(1).max(1000),
				estimatedSeconds: z.number().int().min(1).max(36000),
				owns: z.array(ownedPath).max(20),
				dependsOn: z.array(z.string()).max(12).default([]),
			}),
		)
		.min(1)
		.max(12),
});

type Plan = z.infer<typeof parallelWorkPlan>;

function pathsOverlap(left: string, right: string) {
	const a = left.replace(/\/$/, "");
	const b = right.replace(/\/$/, "");
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Advisory schedule from explicit estimates, not reservations or predicted model speed. */
export function scheduleParallelWork(raw: Plan, capacity: number) {
	const { tasks } = parallelWorkPlan.parse(raw);
	if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5)
		throw new Error("Scheduling capacity must be between one and five.");
	const byId = new Map(tasks.map((task) => [task.id, task]));
	if (byId.size !== tasks.length) throw new Error("Plan IDs must be unique.");
	const ancestors = new Map<string, Set<string>>();
	function prerequisites(
		id: string,
		visiting = new Set<string>(),
	): Set<string> {
		const cached = ancestors.get(id);
		if (cached) return cached;
		if (visiting.has(id)) throw new Error("Plan dependencies contain a cycle.");
		const task = byId.get(id);
		if (!task) throw new Error(`Unknown prerequisite: ${id}`);
		const next = new Set([...visiting, id]);
		const result = new Set<string>();
		for (const dependency of task.dependsOn) {
			result.add(dependency);
			for (const ancestor of prerequisites(dependency, next))
				result.add(ancestor);
		}
		ancestors.set(id, result);
		return result;
	}
	for (const task of tasks) prerequisites(task.id);
	for (let a = 0; a < tasks.length; a++) {
		for (let b = a + 1; b < tasks.length; b++) {
			const left = tasks[a],
				right = tasks[b];
			if (
				left.owns.some((path) =>
					right.owns.some((other) => pathsOverlap(path, other)),
				) &&
				!prerequisites(left.id).has(right.id) &&
				!prerequisites(right.id).has(left.id)
			)
				throw new Error(
					`Unordered write ownership overlaps: ${left.id} and ${right.id}`,
				);
		}
	}
	const paths = new Map<string, number>();
	function remainingPath(id: string): number {
		const cached = paths.get(id);
		if (cached !== undefined) return cached;
		const dependents = tasks.filter((task) => task.dependsOn.includes(id));
		const task = byId.get(id);
		if (!task) throw new Error(`Unknown task: ${id}`);
		const duration =
			task.estimatedSeconds +
			Math.max(0, ...dependents.map((task) => remainingPath(task.id)));
		paths.set(id, duration);
		return duration;
	}
	const pending = new Set(byId.keys());
	const done = new Set<string>();
	const running: { id: string; end: number }[] = [];
	const schedule: {
		id: string;
		start: number;
		end: number;
		criticalPathSeconds: number;
	}[] = [];
	let now = 0;
	while (pending.size || running.length) {
		const ready = tasks
			.filter(
				(task) =>
					pending.has(task.id) && task.dependsOn.every((id) => done.has(id)),
			)
			.sort(
				(a, b) =>
					remainingPath(b.id) - remainingPath(a.id) || a.id.localeCompare(b.id),
			);
		for (const task of ready.slice(0, capacity - running.length)) {
			const end = now + task.estimatedSeconds;
			pending.delete(task.id);
			running.push({ id: task.id, end });
			schedule.push({
				id: task.id,
				start: now,
				end,
				criticalPathSeconds: remainingPath(task.id),
			});
		}
		if (!running.length) throw new Error("No runnable task remains.");
		now = Math.min(...running.map((task) => task.end));
		for (let index = running.length - 1; index >= 0; index--) {
			if (running[index].end === now) {
				done.add(running[index].id);
				running.splice(index, 1);
			}
		}
	}
	return {
		schedule,
		estimatedCompletionSeconds: now,
		initiallyReady: schedule
			.filter((task) => task.start === 0)
			.map((task) => task.id),
		requiredJoins: tasks
			.filter((task) => task.dependsOn.length > 1)
			.map((task) => task.id),
	};
}
