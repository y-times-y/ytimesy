import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_CATALOG_EPOCH,
	CODEX_CATALOG_REFRESH_AFTER_MS,
	codexCatalogStorageKey,
} from "#/domain/codex-catalog-epoch";
import type { ListedModel } from "#/domain/listed-model";
import {
	type CatalogStorage,
	codexCatalogKey,
	codexCatalogQueryOptions,
	forgetManualCodexRefreshesForTests,
	readSavedCodexCatalog,
	recheckCodexCatalogAfterUnavailable,
	refreshCodexCatalog,
	seedCodexCatalog,
	writeSavedCodexCatalog,
} from "./codex-catalog-store";

class MemoryStorage implements CatalogStorage {
	private readonly values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
}

const models: ListedModel[] = [
	{
		id: "gpt-a",
		label: "GPT A",
		reasoning: {
			levels: [
				{ id: "low", label: "Low" },
				{ id: "high", label: "High" },
			],
			defaultLevelId: "low",
		},
		speeds: [{ id: "fast" }],
		contextCapacity: 272000,
		contextWindow: { standard: 272000, alternate: 1000000, note: "n" },
	},
	{ id: "gpt-b", label: "GPT B" },
];
const HOUR = 3600_000;
let storage: MemoryStorage;
let client: QueryClient;
beforeEach(() => {
	storage = new MemoryStorage();
	client = new QueryClient();
	forgetManualCodexRefreshesForTests();
});

/** What the composer and picker do on mount: seed from storage, then observe. */
async function mount(load: ReturnType<typeof loader>, userId = "u1") {
	seedCodexCatalog(client, userId, { storage });
	const observer = new QueryObserver(client, {
		...codexCatalogQueryOptions(userId, load, { storage }),
	});
	const unsubscribe = observer.subscribe(() => {});
	await vi.waitFor(() =>
		expect(observer.getCurrentResult().data).toBeDefined(),
	);
	return { observer, unsubscribe };
}

function loader() {
	return vi.fn(async (_force: boolean) => models);
}

describe("Codex catalog saved copy: request counts", () => {
	it("a fresh saved copy: mount makes 0 requests, and so do more readers (hover, focus, search)", async () => {
		writeSavedCodexCatalog("u1", models, storage);
		const load = loader();
		const first = await mount(load);
		const second = await mount(load);
		expect(load).not.toHaveBeenCalled();
		expect(first.observer.getCurrentResult().data).toEqual(models);
		second.unsubscribe();
		first.unsubscribe();
	});

	it("no saved copy: exactly 1 request, which is saved for the next visit", async () => {
		const load = loader();
		await mount(load);
		await mount(load);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith(false);
		expect(readSavedCodexCatalog("u1", storage)?.models).toEqual(models);
		// The next visit (a new client) is free.
		client = new QueryClient();
		const next = loader();
		await mount(next);
		expect(next).not.toHaveBeenCalled();
	});

	it("an epoch bump is a different key: the old copy is ignored and 1 request is made", async () => {
		storage.setItem(
			codexCatalogStorageKey("u1", CODEX_CATALOG_EPOCH - 1),
			JSON.stringify({ models, savedAt: Date.now() }),
		);
		expect(readSavedCodexCatalog("u1", storage)).toBeNull();
		const load = loader();
		await mount(load);
		expect(load).toHaveBeenCalledTimes(1);
		// Saving under the new key forgets the old key.
		expect(
			storage.getItem(codexCatalogStorageKey("u1", CODEX_CATALOG_EPOCH - 1)),
		).toBeNull();
	});

	it("a copy older than 48 hours: shown at once, then exactly 1 background request", async () => {
		const old = Date.now() - CODEX_CATALOG_REFRESH_AFTER_MS - HOUR;
		storage.setItem(
			codexCatalogStorageKey("u1"),
			JSON.stringify({ models: [models[1]], savedAt: old }),
		);
		const load = loader();
		seedCodexCatalog(client, "u1", { storage });
		expect(client.getQueryData(codexCatalogKey("u1"))).toEqual([models[1]]);
		const observer = new QueryObserver(client, {
			...codexCatalogQueryOptions("u1", load, { storage }),
		});
		const unsubscribe = observer.subscribe(() => {});
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(observer.getCurrentResult().data).toEqual(models),
		);
		// A second reader mounting meanwhile does not ask again.
		const other = new QueryObserver(client, {
			...codexCatalogQueryOptions("u1", load, { storage }),
		}).subscribe(() => {});
		expect(load).toHaveBeenCalledTimes(1);
		other();
		unsubscribe();
	});

	it("a copy under 48 hours old is not re-read", async () => {
		storage.setItem(
			codexCatalogStorageKey("u1"),
			JSON.stringify({ models, savedAt: Date.now() - 47 * HOUR }),
		);
		const load = loader();
		await mount(load);
		expect(load).not.toHaveBeenCalled();
	});

	it("corrupt or oversized storage: ignored, one fetch", async () => {
		const key = codexCatalogStorageKey("u1");
		for (const bad of [
			"not json",
			"[]",
			JSON.stringify({ models: "x", savedAt: 1 }),
			JSON.stringify({ models: [], savedAt: Date.now() }),
			JSON.stringify({ models: [{ id: 3, label: "x" }], savedAt: Date.now() }),
			JSON.stringify({ models, savedAt: Date.now() + 10 * HOUR }),
			JSON.stringify({ models, savedAt: "yesterday" }),
			`{"models":[{"id":"a","label":"${"x".repeat(70_000)}"}],"savedAt":${Date.now()}}`,
		]) {
			storage.setItem(key, bad);
			expect(readSavedCodexCatalog("u1", storage)).toBeNull();
			client = new QueryClient();
			const load = loader();
			await mount(load);
			expect(load).toHaveBeenCalledTimes(1);
		}
	});

	it("unusable storage (throws) falls back to one fetch", async () => {
		const broken: CatalogStorage = {
			length: 0,
			key: () => null,
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("full");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const load = loader();
		seedCodexCatalog(client, "u1", { storage: broken });
		const observer = new QueryObserver(client, {
			...codexCatalogQueryOptions("u1", load, { storage: broken }),
		});
		const stop = observer.subscribe(() => {});
		await vi.waitFor(() =>
			expect(observer.getCurrentResult().data).toBeDefined(),
		);
		expect(load).toHaveBeenCalledTimes(1);
		stop();
	});

	it("rebuilds saved rows field by field (unknown fields are not kept)", () => {
		storage.setItem(
			codexCatalogStorageKey("u1"),
			JSON.stringify({
				models: [{ ...models[1], secret: "x", speeds: [{ id: "warp" }] }],
				savedAt: Date.now(),
			}),
		);
		// A bad speed is dropped from the row; the unknown field never comes back.
		expect(readSavedCodexCatalog("u1", storage)?.models).toEqual([models[1]]);
	});
});

describe("Codex catalog re-check triggers", () => {
	it("a model-unavailable failure drops the saved copy and makes exactly 1 forced request", async () => {
		writeSavedCodexCatalog("u1", models, storage);
		const load = loader();
		await mount(load);
		expect(load).not.toHaveBeenCalled();
		const next = [models[1]];
		load.mockResolvedValueOnce(next);
		await recheckCodexCatalogAfterUnavailable(client, "u1", load, { storage });
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith(true);
		expect(client.getQueryData(codexCatalogKey("u1"))).toEqual(next);
		expect(readSavedCodexCatalog("u1", storage)?.models).toEqual(next);
	});

	it("a failed forced re-check leaves no saved copy, so the next visit reads once", async () => {
		writeSavedCodexCatalog("u1", models, storage);
		const load = vi.fn(async (_force: boolean): Promise<ListedModel[]> => {
			throw new Error("down");
		});
		await recheckCodexCatalogAfterUnavailable(client, "u1", load, { storage });
		expect(load).toHaveBeenCalledTimes(1);
		expect(readSavedCodexCatalog("u1", storage)).toBeNull();
	});

	it("the refresh button: 1 forced request per 60 s", async () => {
		const load = loader();
		let now = 1_000_000;
		const press = () =>
			refreshCodexCatalog(client, "u1", load, {
				manual: true,
				storage,
				now: () => now,
			});
		expect(await press()).toBe(true);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenLastCalledWith(true);
		now += 59_000;
		expect(await press()).toBe(false);
		expect(load).toHaveBeenCalledTimes(1);
		now += 1_000;
		expect(await press()).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("never reads before the user is known", async () => {
		const load = loader();
		expect(seedCodexCatalog(client, undefined, { storage })).toBe(false);
		expect(await refreshCodexCatalog(client, undefined, load)).toBe(false);
		await recheckCodexCatalogAfterUnavailable(client, undefined, load);
		expect(load).not.toHaveBeenCalled();
	});
});

describe("Codex catalog on the server render", () => {
	it("touches no window or storage", () => {
		expect(typeof window).toBe("undefined");
		expect(readSavedCodexCatalog("u1")).toBeNull();
		expect(() => writeSavedCodexCatalog("u1", models)).not.toThrow();
		expect(seedCodexCatalog(new QueryClient(), "u1")).toBe(false);
	});
});
