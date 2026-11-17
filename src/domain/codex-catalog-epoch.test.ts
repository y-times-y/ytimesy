import { describe, expect, it } from "vitest";
import {
	CODEX_CATALOG_EPOCH,
	CODEX_CATALOG_REFRESH_AFTER_MS,
	codexCatalogStorageKey,
} from "./codex-catalog-epoch";
import { PINNED_CODEX_CLI_VERSION } from "./guest-cli-pin";

describe("Codex catalog saved-copy key", () => {
	it("is user + pinned CLI version + epoch", () => {
		expect(codexCatalogStorageKey("u1")).toBe(
			`ytimesy:codex-catalog:u1:${PINNED_CODEX_CLI_VERSION}:${CODEX_CATALOG_EPOCH}`,
		);
	});

	it("documents the bump workflow: a new epoch or pin is a new key, so every saved copy is re-read once", () => {
		const before = codexCatalogStorageKey("u1");
		expect(codexCatalogStorageKey("u1", CODEX_CATALOG_EPOCH + 1)).not.toBe(
			before,
		);
		expect(codexCatalogStorageKey("u1", CODEX_CATALOG_EPOCH, "9.9.9")).not.toBe(
			before,
		);
		expect(codexCatalogStorageKey("u2")).not.toBe(before);
	});

	it("re-checks a saved copy after 48 hours as a safety net", () => {
		expect(CODEX_CATALOG_REFRESH_AFTER_MS).toBe(48 * 3600_000);
	});
});
