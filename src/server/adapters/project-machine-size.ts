import {
	DEFAULT_MACHINE_SIZE,
	type MachineSizeId,
	machineSizeId,
} from "#/domain/machine-size";
import { database } from "./database";

export async function projectMachineSize(
	userId: string,
	projectId: string,
): Promise<MachineSizeId> {
	const result = await database().query<{ machine_size: string }>(
		"select machine_size from project where id=$1 and user_id=$2",
		[projectId, userId],
	);
	if (!result.rows[0]) throw new Error("Project is not available.");
	return machineSizeId.parse(
		result.rows[0].machine_size ?? DEFAULT_MACHINE_SIZE,
	);
}

export async function saveProjectMachineSize(
	userId: string,
	projectId: string,
	size: MachineSizeId,
): Promise<MachineSizeId> {
	const result = await database().query(
		"update project set machine_size=$3 where id=$1 and user_id=$2 returning id",
		[projectId, userId, machineSizeId.parse(size)],
	);
	if (!result.rows[0]) throw new Error("Project is not available.");
	return size;
}
