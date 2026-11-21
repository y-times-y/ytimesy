import { presignedR2Url, r2Configuration } from "../adapters/checkpoints/r2";
import type { TurnBoxBundle } from "./turn-box-routes";

/** The object scripts/publish-turn-box.ts writes last: which program is current. */
export const TURN_BOX_MANIFEST_KEY = "turn-box/latest.json";
const LINK_SECONDS = 300;

/**
 * The turn box program to download: a five-minute link to the current
 * bundle in the private R2 bucket (the box holds no R2 key) and its checksum.
 * Null while nothing is published or R2 is not configured.
 */
export async function turnBoxBundleFromR2(
	now = new Date(),
): Promise<TurnBoxBundle | null> {
	const config = r2Configuration();
	if (!config) return null;
	const manifest = await fetch(
		presignedR2Url({
			config,
			method: "GET",
			key: TURN_BOX_MANIFEST_KEY,
			expiresSeconds: 60,
			now,
		}),
		{ redirect: "manual", signal: AbortSignal.timeout(15_000) },
	);
	if (!manifest.ok) {
		await manifest.body?.cancel().catch(() => undefined);
		return null;
	}
	const parsed = (await manifest.json()) as {
		key?: unknown;
		sha256?: unknown;
		version?: unknown;
	};
	if (
		typeof parsed.key !== "string" ||
		!/^turn-box\/[a-f0-9]{16,64}\.mjs\.gz$/.test(parsed.key) ||
		typeof parsed.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(parsed.sha256) ||
		typeof parsed.version !== "string"
	)
		return null;
	return {
		url: presignedR2Url({
			config,
			method: "GET",
			key: parsed.key,
			expiresSeconds: LINK_SECONDS,
			now,
		}),
		sha256: parsed.sha256,
		version: parsed.version,
	};
}
