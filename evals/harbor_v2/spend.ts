import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LanguageModel } from "ai";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import {
	type ModelBilling,
	usageCostUsd,
} from "../../src/domain/model-pricing";

/**
 * Spending limits for Harbor bridge v2 trials.
 *
 * Per trial: every model request (builder, checker and native compaction)
 * goes through a guarded model that refuses the next request once the
 * trial's list-price estimate reaches its cap or the request limit is used.
 *
 * Total: a JSON-lines ledger shared by every trial of a campaign. Before a
 * trial starts it reserves its whole cap; it may start only if the settled
 * spend plus every open reservation plus its own cap stays within the total.
 * At the end it settles its estimate. A trial that dies without settling
 * keeps its reservation (conservative: the total can only be overcounted).
 * A `<ledger>.stop` file refuses every new trial. When the committed total
 * first reaches 50% and then 80% of the total cap, a `warning` line is
 * appended (once each) and returned for the trial's log.
 */

export class SpendCapReached extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpendCapReached";
	}
}

/** Dollars for cumulative usage; unknown prices count as the cap (never as free). */
export function estimatedUsd(
	usage: ApiTokenUsage | null,
	billing: ModelBilling,
) {
	if (!usage) return 0;
	return usageCostUsd(usage, billing) ?? Number.POSITIVE_INFINITY;
}

export type TrialSpendGuard = {
	readonly requests: () => number;
	readonly spentUsd: () => number;
	/** Throws SpendCapReached when the next request may not start. */
	readonly beforeRequest: () => void;
	/** Why the guard refused a request (the model loop reports only a generic failure). */
	readonly stopReason: () => string | null;
};

/** One model run's cumulative usage at its own route's price. */
export type SpendPart = {
	readonly usage: ApiTokenUsage | null;
	readonly billing: ModelBilling;
};

export function trialSpendGuard(input: {
	capUsd: number | null;
	requestLimit: number;
	/**
	 * Every model run of this trial so far (builder runs and checkers), each
	 * priced at its own model: a checker on roleModels.checker costs its price.
	 */
	parts: () => readonly SpendPart[];
}): TrialSpendGuard {
	let requests = 0;
	let stopped: string | null = null;
	const spentUsd = () =>
		input
			.parts()
			.reduce(
				(total, part) => total + estimatedUsd(part.usage, part.billing),
				0,
			);
	const refuse = (reason: string) => {
		stopped = reason;
		throw new SpendCapReached(reason);
	};
	return {
		requests: () => requests,
		spentUsd,
		stopReason: () => stopped,
		beforeRequest: () => {
			if (requests >= input.requestLimit)
				refuse(`Trial request limit reached (${input.requestLimit}).`);
			const spent = spentUsd();
			if (input.capUsd !== null && spent >= input.capUsd)
				refuse(
					`Trial spending cap reached: $${spent.toFixed(4)} of $${input.capUsd}.`,
				);
			requests++;
		},
	};
}

/**
 * The model with every doStream/doGenerate call checked against the guard
 * first. Native compaction must be rebuilt on the returned model so its
 * requests are counted too.
 */
export function guardedLanguageModel(
	model: LanguageModel,
	guard: TrialSpendGuard,
	signal: AbortSignal,
): LanguageModel {
	if (typeof model === "string")
		throw new Error("Expected a concrete model transport.");
	return new Proxy(model, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property === "doStream" || property === "doGenerate")
				return (...args: unknown[]) => {
					signal.throwIfAborted();
					guard.beforeRequest();
					return (value as (...rest: unknown[]) => unknown).apply(target, args);
				};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

type LedgerEntry =
	| { type: "reserve"; trial: string; usd: number; at: string }
	| { type: "settle"; trial: string; usd: number; at: string }
	| {
			type: "warning";
			/** The share of the total cap now committed (0.5 or 0.8). */
			threshold: number;
			committedUsd: number;
			totalCapUsd: number;
			message: string;
			at: string;
	  };

export const LEDGER_WARNING_THRESHOLDS = [0.5, 0.8] as const;

async function readLedger(path: string): Promise<LedgerEntry[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerEntry);
}

/** Settled spend plus every reservation not yet settled. */
export function committedUsd(entries: readonly LedgerEntry[]) {
	const settled = new Map<string, number>();
	const reserved = new Map<string, number>();
	for (const entry of entries)
		if (entry.type !== "warning")
			(entry.type === "settle" ? settled : reserved).set(
				entry.trial,
				entry.usd,
			);
	let total = 0;
	for (const usd of settled.values()) total += usd;
	for (const [trial, usd] of reserved) if (!settled.has(trial)) total += usd;
	return total;
}

/**
 * Appends a warning line for each threshold the committed total has reached
 * without one yet; returns the new warnings' messages. Call under the lock.
 */
async function appendLedgerWarnings(
	path: string,
	entries: readonly LedgerEntry[],
	totalCapUsd: number,
) {
	const committed = committedUsd(entries);
	const warned = new Set(
		entries.flatMap((entry) =>
			entry.type === "warning" ? [entry.threshold] : [],
		),
	);
	const messages: string[] = [];
	for (const threshold of LEDGER_WARNING_THRESHOLDS) {
		if (warned.has(threshold) || committed < threshold * totalCapUsd) continue;
		const message = `Spend ledger at ${Math.round(threshold * 100)}% of its total cap: $${committed.toFixed(2)} committed of $${totalCapUsd}.`;
		const entry: LedgerEntry = {
			type: "warning",
			threshold,
			committedUsd: committed,
			totalCapUsd,
			message,
			at: new Date().toISOString(),
		};
		await appendFile(path, `${JSON.stringify(entry)}\n`);
		messages.push(message);
	}
	return messages;
}

/** A cross-process lock: mkdir is atomic. A lock older than a minute is stale. */
async function withLedgerLock<T>(path: string, run: () => Promise<T>) {
	const lock = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true });
	for (let attempt = 0; ; attempt++) {
		try {
			await mkdir(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const age = await stat(lock).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0,
			);
			if (age > 60_000) await rm(lock, { recursive: true, force: true });
			else if (attempt > 600) throw new Error("The spend ledger stays locked.");
			else await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	try {
		return await run();
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

export async function reserveTrial(input: {
	ledger: string;
	totalCapUsd: number;
	trial: string;
	trialCapUsd: number;
}) {
	return withLedgerLock(input.ledger, async () => {
		try {
			await stat(`${input.ledger}.stop`);
			throw new SpendCapReached(
				"The operator stopped new trials (spend ledger stop file).",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const entries = await readLedger(input.ledger);
		if (
			entries.some(
				(entry) => entry.type !== "warning" && entry.trial === input.trial,
			)
		)
			throw new Error(`Trial ${input.trial} is already in the spend ledger.`);
		const committed = committedUsd(entries);
		if (committed + input.trialCapUsd > input.totalCapUsd)
			throw new SpendCapReached(
				`Total spending cap: $${committed.toFixed(2)} committed + this trial's $${input.trialCapUsd} cap exceeds $${input.totalCapUsd}.`,
			);
		const entry: LedgerEntry = {
			type: "reserve",
			trial: input.trial,
			usd: input.trialCapUsd,
			at: new Date().toISOString(),
		};
		await appendFile(input.ledger, `${JSON.stringify(entry)}\n`);
		const warnings = await appendLedgerWarnings(
			input.ledger,
			[...entries, entry],
			input.totalCapUsd,
		);
		return { committedUsd: committed, warnings };
	});
}

export async function settleTrial(input: {
	ledger: string;
	trial: string;
	usd: number;
	/** The total cap, for the 50%/80% warning lines. */
	totalCapUsd?: number;
}): Promise<{ warnings: string[] }> {
	return withLedgerLock(input.ledger, async () => {
		// An unknown estimate settles at the trial's reservation.
		const entries = await readLedger(input.ledger);
		const reserved = entries.find(
			(entry): entry is Extract<LedgerEntry, { type: "reserve" }> =>
				entry.type === "reserve" && entry.trial === input.trial,
		);
		const entry: LedgerEntry = {
			type: "settle",
			trial: input.trial,
			usd: Number.isFinite(input.usd) ? input.usd : (reserved?.usd ?? 0),
			at: new Date().toISOString(),
		};
		await appendFile(input.ledger, `${JSON.stringify(entry)}\n`);
		return {
			warnings:
				input.totalCapUsd === undefined
					? []
					: await appendLedgerWarnings(
							input.ledger,
							[...entries, entry],
							input.totalCapUsd,
						),
		};
	});
}

export async function ledgerSummary(ledger: string) {
	const entries = await readLedger(ledger);
	return {
		committedUsd: committedUsd(entries),
		entries: entries.length,
		warnings: entries.flatMap((entry) =>
			entry.type === "warning" ? [entry.message] : [],
		),
	};
}
