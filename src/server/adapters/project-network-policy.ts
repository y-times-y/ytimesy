import {
	DEFAULT_VM_NETWORK_POLICY,
	type VmNetworkPolicy,
	vmNetworkPolicy,
} from "#/domain/vm-network-policy";
import { database } from "./database";

export async function projectNetworkPolicy(
	userId: string,
	projectId: string,
): Promise<VmNetworkPolicy> {
	const result = await database().query<{
		network_mode: string | null;
		network_domains: string[] | null;
	}>(
		"select network_mode, network_domains from project where id=$1 and user_id=$2",
		[projectId, userId],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Project is not available.");
	const parsed = vmNetworkPolicy.safeParse({
		mode: row.network_mode ?? DEFAULT_VM_NETWORK_POLICY.mode,
		domains: row.network_domains ?? [],
	});
	// A stored value that no longer validates fails closed to the project's
	// own list rather than opening the internet.
	return parsed.success ? parsed.data : { mode: "allowlist", domains: [] };
}

export async function saveProjectNetworkPolicy(
	userId: string,
	projectId: string,
	policy: VmNetworkPolicy,
): Promise<VmNetworkPolicy> {
	const valid = vmNetworkPolicy.parse(policy);
	const result = await database().query(
		"update project set network_mode=$3, network_domains=$4 where id=$1 and user_id=$2 returning id",
		[projectId, userId, valid.mode, valid.domains],
	);
	if (!result.rows[0]) throw new Error("Project is not available.");
	return valid;
}
