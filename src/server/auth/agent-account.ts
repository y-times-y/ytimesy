import type { UserAgentAccount } from "../../domain/user-agent-account";
import { database } from "../adapters/database";
import { seal, unseal } from "./token-vault";

export type AgentAccountProvider = "codex" | "claude";

interface AgentAccountRow {
	status: "disconnected" | "connected" | "expired";
	provider: AgentAccountProvider;
	encrypted_snapshot_id: string | null;
	encrypted_codex_auth: string | null;
	plan_type: string | null;
	email: string | null;
	message: string | null;
}

export async function loadAgentAccount(
	userId: string,
): Promise<UserAgentAccount> {
	const result = await database().query(
		"select status,provider,encrypted_snapshot_id,encrypted_codex_auth,plan_type,email,message from agent_account where user_id=$1 and provider='codex'",
		[userId],
	);
	return toAccount(result.rows[0]);
}

export async function loadAgentSnapshotId(userId: string) {
	return loadHarnessSnapshotId(userId, "codex");
}

export async function loadHarnessSnapshotId(
	userId: string,
	provider: AgentAccountProvider,
) {
	const result = await database().query(
		"select status,encrypted_snapshot_id from agent_account where user_id=$1 and provider=$2",
		[userId, provider],
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
		provider: AgentAccountProvider;
		snapshotId: string;
		planType: string | null;
		email: string | null;
	},
) {
	await database().query(
		`insert into agent_account(user_id,provider,status,encrypted_snapshot_id,plan_type,email,message)
		 values($1,$2,'connected',$3,$4,$5,null)
		 on conflict(user_id, provider) do update set
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
		`insert into agent_account(user_id,provider,status,encrypted_snapshot_id,encrypted_codex_auth,plan_type,email,message)
		 values($1,'codex','expired',null,null,null,null,$2)
		 on conflict(user_id, provider) do update set
		  status='expired',
		  encrypted_snapshot_id=null,
		  encrypted_codex_auth=null,
		  plan_type=null,
		  email=null,
		  message=$2,
		  updated_at=now()`,
		[userId, message],
	);
}

export async function disconnectAgentAccount(userId: string) {
	await database().query(
		"delete from agent_account where user_id=$1 and provider='codex'",
		[userId],
	);
}

function toAccount(row: AgentAccountRow | undefined): UserAgentAccount {
	if (!row || row.status === "disconnected") return { status: "disconnected" };
	if (row.status === "expired")
		return { status: "expired", message: row.message ?? "Reconnect Codex." };
	if (!row.encrypted_codex_auth) {
		return {
			status: "expired",
			message: "Reconnect Codex to update its login.",
		};
	}
	return {
		status: "connected",
		provider: row.provider === "claude" ? "codex" : row.provider,
		planType: row.plan_type,
		email: row.email,
	};
}
