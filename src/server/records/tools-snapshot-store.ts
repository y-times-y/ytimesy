import { readFile } from "node:fs/promises";
import {
	toolsSnapshotIdFromEnv,
	toolsSnapshotIdFromRecord,
} from "#/domain/workspace-boot-snapshot";
import { CHEAP_BASE_SNAPSHOT } from "#/server/adapters/freestyle/product-vm";
import { loadToolsSnapshotSetting } from "#/server/adapters/product-settings";

const TOOLS_SNAPSHOT_STATE_PATH = ".ytimesy/tools-snapshot.json";

export async function readToolsSnapshotId(
	path = TOOLS_SNAPSHOT_STATE_PATH,
): Promise<string | undefined> {
	return (
		(await loadToolsSnapshotSetting().catch(() => undefined)) ??
		(await readToolsSnapshotFile(path))
	);
}

async function readToolsSnapshotFile(
	path: string,
): Promise<string | undefined> {
	try {
		return toolsSnapshotIdFromRecord(
			JSON.parse(await readFile(path, "utf8")) as unknown,
		);
	} catch {
		return undefined;
	}
}

/** The image a fresh workspace VM boots from: the shared tools image when one is configured. */
export async function workspaceBootSnapshotId(): Promise<string> {
	return (
		toolsSnapshotIdFromEnv(process.env) ??
		(await readToolsSnapshotId()) ??
		CHEAP_BASE_SNAPSHOT
	);
}
