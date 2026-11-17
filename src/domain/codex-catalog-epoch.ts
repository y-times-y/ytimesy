import { PINNED_CODEX_CLI_VERSION } from "./guest-cli-pin";

/**
 * Bump when OpenAI launches a Codex model (or changes the catalog): every user
 * re-checks their own account once on their next visit.
 *
 * ChatGPT's live catalog (`codex/models`) is the only authority on what an
 * account may use, so each browser keeps the user's own copy and asks again
 * only on a real trigger (see docs/model-connections.md, "Codex model list").
 */
export const CODEX_CATALOG_EPOCH = 2;

/** Safety net only: a saved copy this old is re-read once in the background. */
export const CODEX_CATALOG_REFRESH_AFTER_MS = 48 * 3600_000;

/** The "Refresh models" button works once per this long. */
export const CODEX_CATALOG_REFRESH_BUTTON_MS = 60_000;

const STORAGE_PREFIX = "ytimesy:codex-catalog:";

/** One user's saved-copy key: it changes with the pinned CLI version and the epoch. */
export function codexCatalogStorageKey(
	userId: string,
	epoch: number = CODEX_CATALOG_EPOCH,
	cliVersion: string = PINNED_CODEX_CLI_VERSION,
): string {
	return `${STORAGE_PREFIX}${userId}:${cliVersion}:${epoch}`;
}

/** Every saved-copy key of one user, whatever its version or epoch. */
export function codexCatalogStoragePrefix(userId: string): string {
	return `${STORAGE_PREFIX}${userId}:`;
}
