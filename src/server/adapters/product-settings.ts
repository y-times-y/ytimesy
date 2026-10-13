import { toolsSnapshotIdFromRecord } from "#/domain/workspace-boot-snapshot";
import { database } from "./database";

const TOOLS_SNAPSHOT_SETTING_KEY = "tools_snapshot_id";

async function loadProductSetting(key: string): Promise<string | undefined> {
	const result = await database().query(
		"select value from product_setting where key=$1",
		[key],
	);
	const value = result.rows[0]?.value;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function loadToolsSnapshotSetting(): Promise<string | undefined> {
	const value = await loadProductSetting(TOOLS_SNAPSHOT_SETTING_KEY);
	return toolsSnapshotIdFromRecord({ snapshotId: value });
}
