import { readFile } from "node:fs/promises";
import { toolsSnapshotIdFromRecord } from "#/domain/workspace-boot-snapshot";
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
