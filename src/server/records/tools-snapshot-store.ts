import { readFile } from "node:fs/promises";
import { toolsSnapshotIdFromRecord } from "#/domain/workspace-boot-snapshot";

export const TOOLS_SNAPSHOT_STATE_PATH = ".ytimesy/tools-snapshot.json";

export async function readToolsSnapshotId(
	path = TOOLS_SNAPSHOT_STATE_PATH,
): Promise<string | undefined> {
	try {
		return toolsSnapshotIdFromRecord(
			JSON.parse(await readFile(path, "utf8")) as unknown,
		);
	} catch {
		return undefined;
	}
}
