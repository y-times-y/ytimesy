import type {
	QueryClient,
	QueryKey,
	UseQueryOptions,
} from "@tanstack/react-query";
import {
	CODEX_CATALOG_REFRESH_AFTER_MS,
	CODEX_CATALOG_REFRESH_BUTTON_MS,
	codexCatalogStorageKey,
	codexCatalogStoragePrefix,
} from "#/domain/codex-catalog-epoch";
import { listedContextWindow } from "#/domain/context-window-option";
import type {
	ListedModel,
	ListedReasoning,
	ListedSpeed,
} from "#/domain/listed-model";
import { isRetiredModel } from "#/domain/retired-model";

/**
 * The user's own Codex (ChatGPT plan) model list, saved in this browser under
 * a key made of user + pinned CLI version + CODEX_CATALOG_EPOCH. It is read
 * synchronously (no request) and written after every successful fetch; the
 * re-check rules are in docs/model-connections.md ("Codex model list").
 */
export type SavedCodexCatalog = {
	readonly models: readonly ListedModel[];
	readonly savedAt: number;
};

export type CatalogStorage = Pick<
	Storage,
	"getItem" | "setItem" | "removeItem" | "key" | "length"
>;

/** Bounds on what is read back: a corrupt or hostile value is ignored. */
const MAX_SAVED_BYTES = 64 * 1024;
const MAX_MODELS = 60;
const MAX_LEVELS = 12;

export function codexCatalogKey(userId: string | undefined) {
	return ["agent-model-catalog", userId, "codex"] as const;
}

/** The browser's storage; none on the server or when the browser refuses it. */
function browserStorage(): CatalogStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function text(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max
		? value
		: undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function sanitizeReasoning(value: unknown): ListedReasoning | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { levels, defaultLevelId } = value as Record<string, unknown>;
	if (!Array.isArray(levels) || levels.length > MAX_LEVELS) return undefined;
	const rows: { id: string; label: string }[] = [];
	for (const level of levels) {
		if (!level || typeof level !== "object") return undefined;
		const id = text((level as Record<string, unknown>).id, 64);
		const label = text((level as Record<string, unknown>).label, 100);
		if (!id || !label) return undefined;
		rows.push({ id, label });
	}
	const defaultId = text(defaultLevelId, 64);
	const [first, ...rest] = rows;
	if (!first || !defaultId) return undefined;
	return { levels: [first, ...rest], defaultLevelId: defaultId };
}

function sanitizeSpeeds(value: unknown): ListedSpeed[] | undefined {
	if (!Array.isArray(value) || value.length > 4) return undefined;
	const speeds: ListedSpeed[] = [];
	for (const speed of value) {
		if (!speed || typeof speed !== "object") return undefined;
		const { id, priceMultiple } = speed as Record<string, unknown>;
		if (id !== "fast" && id !== "ultrafast") return undefined;
		speeds.push(
			typeof priceMultiple === "number" && Number.isFinite(priceMultiple)
				? { id, priceMultiple }
				: { id },
		);
	}
	return speeds;
}

/** One saved model, rebuilt field by field; null when it is not a usable row. */
function sanitizeModel(value: unknown): ListedModel | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	const id = text(row.id, 200);
	const label = text(row.label, 200);
	if (!id || !label) return null;
	const notice = text(row.notice, 500);
	const fastModeId = text(row.fastModeId, 200);
	const speeds = sanitizeSpeeds(row.speeds);
	const reasoning = sanitizeReasoning(row.reasoning);
	const contextWindow = listedContextWindow(row.contextWindow);
	const contextCapacity = positiveInteger(row.contextCapacity);
	return {
		id,
		label,
		...(notice ? { notice } : {}),
		...(row.supportsFastMode === true ? { supportsFastMode: true } : {}),
		...(speeds ? { speeds } : {}),
		...(fastModeId ? { fastModeId } : {}),
		...(reasoning ? { reasoning } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(contextCapacity ? { contextCapacity } : {}),
	};
}

/** A parsed list, or null when anything about it is wrong (never a partial list). */
export function sanitizeCodexModels(value: unknown): ListedModel[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS)
		return null;
	const models: ListedModel[] = [];
	for (const entry of value) {
		const model = sanitizeModel(entry);
		if (!model) return null;
		// A copy saved before a retirement must not bring the model back.
		if (!isRetiredModel(model.id)) models.push(model);
	}
	return models.length ? models : null;
}

/** The saved copy for this key; null when absent, oversized, corrupt or from the future. */
export function readSavedCodexCatalog(
	userId: string | undefined,
	storage: CatalogStorage | null = browserStorage(),
	now: number = Date.now(),
): SavedCodexCatalog | null {
	if (!userId || !storage) return null;
	try {
		const raw = storage.getItem(codexCatalogStorageKey(userId));
		if (!raw || raw.length > MAX_SAVED_BYTES) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const { models, savedAt } = parsed as Record<string, unknown>;
		if (
			typeof savedAt !== "number" ||
			!Number.isFinite(savedAt) ||
			savedAt <= 0 ||
			savedAt > now + 60_000
		)
			return null;
		const clean = sanitizeCodexModels(models);
		return clean ? { models: clean, savedAt } : null;
	} catch {
		return null;
	}
}

/** Saves the list read just now, and forgets this user's copies under older keys. */
export function writeSavedCodexCatalog(
	userId: string | undefined,
	models: readonly ListedModel[],
	storage: CatalogStorage | null = browserStorage(),
	now: number = Date.now(),
): void {
	if (!userId || !storage) return;
	const clean = sanitizeCodexModels(models);
	if (!clean) return;
	try {
		const key = codexCatalogStorageKey(userId);
		const prefix = codexCatalogStoragePrefix(userId);
		const old: string[] = [];
		for (let index = 0; index < storage.length; index++) {
			const name = storage.key(index);
			if (name?.startsWith(prefix) && name !== key) old.push(name);
		}
		for (const name of old) storage.removeItem(name);
		const value = JSON.stringify({ models: clean, savedAt: now });
		if (value.length <= MAX_SAVED_BYTES) storage.setItem(key, value);
	} catch {
		/* The list still works from memory when storage is full or blocked. */
	}
}

export function dropSavedCodexCatalog(
	userId: string | undefined,
	storage: CatalogStorage | null = browserStorage(),
): void {
	if (!userId || !storage) return;
	try {
		storage.removeItem(codexCatalogStorageKey(userId));
	} catch {
		/* Nothing saved to drop. */
	}
}

/** Reads the catalog from the server; `force` skips the server's copy too. */
export type LoadCodexCatalog = (force: boolean) => Promise<ListedModel[]>;

type Environment = {
	readonly storage?: CatalogStorage | null;
	readonly now?: () => number;
};

/**
 * The one query every Codex-catalog reader shares (the picker, its search,
 * the composer). A saved copy is placed in the cache with its own age, so a
 * copy under 48 h old is never re-read on mount, hover or focus, and an older
 * one is re-read once in the background. Without a copy it is read once.
 */
export function codexCatalogQueryOptions(
	userId: string | undefined,
	load: LoadCodexCatalog,
	environment: Environment = {},
) {
	return {
		queryKey: codexCatalogKey(userId) as QueryKey,
		enabled: Boolean(userId),
		queryFn: async () => {
			const models = await load(false);
			writeSavedCodexCatalog(
				userId,
				models,
				environment.storage,
				environment.now?.(),
			);
			return models;
		},
		staleTime: CODEX_CATALOG_REFRESH_AFTER_MS,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	} satisfies UseQueryOptions<ListedModel[]>;
}

/**
 * Puts this key's saved copy into the query cache (with the time it was
 * saved) unless the cache already has data. Returns whether a copy was found.
 */
export function seedCodexCatalog(
	client: QueryClient,
	userId: string | undefined,
	environment: Environment = {},
): boolean {
	if (!userId) return false;
	const key = codexCatalogKey(userId);
	if (client.getQueryData(key) !== undefined) return true;
	const saved = readSavedCodexCatalog(
		userId,
		environment.storage,
		environment.now?.(),
	);
	if (!saved) return false;
	client.setQueryData(key, [...saved.models], { updatedAt: saved.savedAt });
	return true;
}

const manualRefreshes = new Map<string, number>();

/**
 * Asks ChatGPT again, bypassing the server's copy, and saves the answer. The
 * caller's "Refresh models" button is allowed once per 60 s (false: too soon).
 */
export async function refreshCodexCatalog(
	client: QueryClient,
	userId: string | undefined,
	load: LoadCodexCatalog,
	options: { manual?: boolean } & Environment = {},
): Promise<boolean> {
	if (!userId) return false;
	const now = options.now?.() ?? Date.now();
	if (options.manual) {
		const last = manualRefreshes.get(userId);
		if (last !== undefined && now - last < CODEX_CATALOG_REFRESH_BUTTON_MS)
			return false;
		manualRefreshes.set(userId, now);
	}
	await client
		.fetchQuery({
			queryKey: codexCatalogKey(userId),
			queryFn: async () => {
				const models = await load(true);
				writeSavedCodexCatalog(userId, models, options.storage, now);
				return models;
			},
			staleTime: 0,
			retry: false,
		})
		.catch(() => undefined);
	return true;
}

/**
 * A Codex turn failed because the model is not offered to this account: the
 * saved copy was wrong, so drop it and read the account's list once more
 * (bypassing the server's copy).
 */
export async function recheckCodexCatalogAfterUnavailable(
	client: QueryClient,
	userId: string | undefined,
	load: LoadCodexCatalog,
	environment: Environment = {},
): Promise<void> {
	if (!userId) return;
	dropSavedCodexCatalog(userId, environment.storage);
	await refreshCodexCatalog(client, userId, load, environment);
}

/** Test hook: forget when the button last worked. */
export function forgetManualCodexRefreshesForTests() {
	manualRefreshes.clear();
}
