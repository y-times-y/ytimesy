import type { UserAgentAccount } from "../../domain/user-agent-account";
import { database } from "../adapters/database";

interface AgentAccountRow {
	status: "disconnected" | "connected" | "expired";
	encrypted_codex_auth: string | null;
	plan_type: string | null;
	email: string | null;
	message: string | null;
}

export async function loadAgentAccount(
	userId: string,
): Promise<UserAgentAccount> {
	const result = await database().query(
		"select status,encrypted_codex_auth,plan_type,email,message from agent_account where user_id=$1 and provider='codex'",
		[userId],
	);
	return toAccount(result.rows[0]);
}

/**
 * The account, whether its managed login is usable (as hasManagedCodexAuth
 * answers it) and its sealed pending sign-in, from one read of its row.
 */
export async function loadAgentAccountState(userId: string) {
	const result = await database().query<
		AgentAccountRow & { encrypted_device_login: string | null }
	>(
		"select status,encrypted_codex_auth,plan_type,email,message,encrypted_device_login from agent_account where user_id=$1 and provider='codex'",
		[userId],
	);
	const row = result.rows[0];
	return {
		account: toAccount(row),
		managed: row?.status === "connected" && row.encrypted_codex_auth !== null,
		sealedDeviceLogin: row?.encrypted_device_login ?? null,
	};
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
		provider: "codex",
		planType: row.plan_type,
		email: row.email,
	};
}
