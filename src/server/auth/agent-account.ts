import type { UserAgentAccount } from "../../domain/user-agent-account";
import { database } from "../adapters/database";
import { seal, unseal } from "./token-vault";

interface AgentAccountRow {
	status: "disconnected" | "connected" | "expired";
	provider: "codex";
	encrypted_snapshot_id: string | null;
	plan_type: string | null;
	email: string | null;
	message: string | null;
}

export async function loadAgentAccount(
	userId: string,
): Promise<UserAgentAccount> {
	const result = await database().query(
		"select status,provider,encrypted_snapshot_id,plan_type,email,message from agent_account where user_id=$1",
		[userId],
	);
	return toAccount(result.rows[0]);
}

export async function loadAgentSnapshotId(userId: string) {
	const result = await database().query(
		"select status,encrypted_snapshot_id from agent_account where user_id=$1",
		[userId],
	);
	const row = result.rows[0] as
		| { status: string; encrypted_snapshot_id: string | null }
		| undefined;
	if (row?.status !== "connected" || !row.encrypted_snapshot_id) return null;
	return unseal(row.encrypted_snapshot_id);
}

export async function saveConnectedAgentAccount(
	userId: string,
	input: {
		provider: "codex";
		snapshotId: string;
		planType: string | null;
		email: string | null;
	},
) {
	await database().query(
		`insert into agent_account(user_id,provider,status,encrypted_snapshot_id,plan_type,email,message)
		 values($1,$2,'connected',$3,$4,$5,null)
		 on conflict(user_id) do update set
		  provider=excluded.provider,
		  status='connected',
		  encrypted_snapshot_id=excluded.encrypted_snapshot_id,
		  plan_type=excluded.plan_type,
		  email=excluded.email,
		  message=null,
		  updated_at=now()`,
		[
			userId,
			input.provider,
			await seal(input.snapshotId),
			input.planType,
			input.email,
		],
	);
}

export async function expireAgentAccount(userId: string, message: string) {
	await database().query(
		`insert into agent_account(user_id,provider,status,encrypted_snapshot_id,plan_type,email,message)
		 values($1,'codex','expired',null,null,null,$2)
		 on conflict(user_id) do update set
		  status='expired',
		  encrypted_snapshot_id=null,
		  plan_type=null,
		  email=null,
		  message=$2,
		  updated_at=now()`,
		[userId, message],
	);
}

export async function disconnectAgentAccount(userId: string) {
	await database().query("delete from agent_account where user_id=$1", [
		userId,
	]);
}

function toAccount(row: AgentAccountRow | undefined): UserAgentAccount {
	if (!row || row.status === "disconnected") return { status: "disconnected" };
	if (row.status === "expired")
		return { status: "expired", message: row.message ?? "Reconnect Codex." };
	return {
		status: "connected",
		provider: row.provider,
		planType: row.plan_type,
		email: row.email,
	};
}
