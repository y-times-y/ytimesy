import { z } from "zod";
import type { SessionItem } from "./session-item";

const checkReceipt = z.object({
	command: z.string().min(1),
	reference: z.uuid(),
	exitCode: z.number().int(),
	stopped: z.enum(["timeout", "output_limit"]).nullable(),
});

/** Nested patch checks have independently journaled IDs even when their UI output is clipped. */
export function taskCheckJournalIds(items: readonly SessionItem[]) {
	return items.flatMap((item) =>
		item.kind !== "dynamicToolCall"
			? []
			: item.tool === "run_checks"
				? [item.id]
				: item.tool === "apply_patches"
					? [`${item.id}:preflight`, `${item.id}:verification`]
					: [],
	);
}

/** Discover retained output identities, not success: the authorized reader must recheck every receipt against current sources. */
export function taskHandoffReferences(
	items: readonly SessionItem[],
	retained: ReadonlyMap<string, unknown> = new Map(),
) {
	const latest = new Map<string, z.infer<typeof checkReceipt>>();
	const failures = new Set<string>();
	let incomplete = false;
	for (const item of items) {
		if (
			item.kind !== "dynamicToolCall" ||
			!["run_checks", "apply_patches", "integration_check_evidence"].includes(
				item.tool,
			)
		)
			continue;
		let records: z.infer<typeof checkReceipt>[];
		try {
			let raw: unknown;
			if (item.tool === "apply_patches") {
				const preflightId = `${item.id}:preflight`;
				const verificationId = `${item.id}:verification`;
				// Journals are authoritative; clipped outer UI output need not be parsed.
				const output =
					retained.has(verificationId) || retained.has(preflightId)
						? null
						: JSON.parse(item.output ?? "");
				raw = [
					...((retained.get(preflightId) as unknown[]) ??
						output?.verification?.preflightChecks ??
						[]),
					...((retained.get(verificationId) as unknown[]) ??
						output?.verification?.checks ??
						[]),
				];
			} else if (item.tool === "integration_check_evidence") {
				raw = [JSON.parse(item.output ?? "")];
			} else
				raw = retained.has(item.id)
					? retained.get(item.id)
					: JSON.parse(item.output ?? "");
			const parsed = z.array(checkReceipt).safeParse(raw);
			if (!parsed.success) {
				incomplete = true;
				continue;
			}
			records = parsed.data;
		} catch {
			incomplete = true;
			continue;
		}
		for (const record of records) {
			latest.delete(record.command);
			latest.set(record.command, record);
			if (record.exitCode !== 0 || record.stopped !== null)
				failures.add(record.reference);
		}
	}
	return {
		references: [...latest.values()].map((check) => check.reference),
		failedReferences: [...failures],
		incomplete,
	};
}
