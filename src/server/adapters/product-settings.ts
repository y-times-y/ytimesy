import { toolsSnapshotIdFromRecord } from "#/domain/workspace-boot-snapshot";
import { database } from "./database";

export const TOOLS_SNAPSHOT_SETTING_KEY = "tools_snapshot_id";

export async function loadProductSetting(
	key: string,
): Promise<string | undefined> {
	const result = await database().query(
		"select value from product_setting where key=$1",
		[key],
	);
	const value = result.rows[0]?.value;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function saveProductSetting(
	key: string,
	value: string,
): Promise<void> {
	await database().query(
		`insert into product_setting(key, value, updated_at)
		 values ($1, $2, now())
		 on conflict (key) do update set value=excluded.value, updated_at=now()`,
		[key, value],
	);
}

export async function loadToolsSnapshotSetting(): Promise<string | undefined> {
	const value = await loadProductSetting(TOOLS_SNAPSHOT_SETTING_KEY);
	return toolsSnapshotIdFromRecord({ snapshotId: value });
}
