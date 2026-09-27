import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database } from "../adapters/database";
import type { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { seal, unseal } from "./token-vault";

type ManagedCodexAuth = {
	readonly auth_mode: "chatgpt";
	readonly tokens: {
		readonly access_token: string;
		readonly refresh_token: string;
		readonly account_id: string;
		readonly id_token?: string;
	};
};

export type CodexExternalTokens = {
	readonly accessToken: string;
	readonly chatgptAccountId: string;
	readonly chatgptPlanType?: string;
};

function managedAuth(value: unknown): ManagedCodexAuth {
	if (!value || typeof value !== "object") throw new Error("Codex login is missing.");
	const record = value as Record<string, unknown>;
	const tokens = record.tokens as Record<string, unknown> | undefined;
	if (
		record.auth_mode !== "chatgpt" ||
		!tokens ||
		![tokens.access_token, tokens.refresh_token, tokens.account_id].every(
			(value) => typeof value === "string" && value.length > 0,
		)
	) {
		throw new Error("Codex login is incomplete; reconnect Codex.");
	}
	return value as ManagedCodexAuth;
}

export function codexAccessTokenExpiresAt(auth: ManagedCodexAuth): number {
	const payload = auth.tokens.access_token.split(".")[1];
	if (!payload) throw new Error("Codex access token is invalid; reconnect Codex.");
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
			exp?: unknown;
		};
		if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
			return claims.exp * 1000;
		}
	} catch {
		// A malformed token must never be treated as fresh.
	}
	throw new Error("Codex access token is invalid; reconnect Codex.");
}

export async function hasManagedCodexAuth(userId: string): Promise<boolean> {
	const result = await database().query(
		"select 1 from agent_account where user_id=$1 and provider='codex' and status='connected' and encrypted_codex_auth is not null",
		[userId],
	);
	return (result.rowCount ?? 0) > 0;
}

/** Moves the one-time device-code login into encrypted server state. */
export async function captureManagedCodexAuth(
	userId: string,
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	planType: string | null,
): Promise<void> {
	const locate = await machines.exec(workspaceId, "printenv HOME", 15_000);
	if (locate.exitCode !== 0) throw new Error("Cannot locate Codex login.");
	const home = locate.stdout.trim();
	if (!home.startsWith("/") || home.includes("\n")) {
		throw new Error("Cannot locate Codex login.");
	}
	const contents = await machines.readTextFile(
		workspaceId,
		`${home}/.codex/auth.json`,
	);
	if (!contents) throw new Error("Codex login was not saved; reconnect Codex.");
	const auth = managedAuth(JSON.parse(contents) as unknown);
	if (codexAccessTokenExpiresAt(auth) < Date.now() + 60_000) {
		throw new Error("Codex login has expired; reconnect Codex.");
	}
	await database().query(
		`insert into agent_account(user_id,provider,status,encrypted_codex_auth,encrypted_snapshot_id,plan_type)
		 values($1,'codex','connected',$2,null,$3)
		 on conflict(user_id,provider) do update set
		 status='connected',encrypted_codex_auth=excluded.encrypted_codex_auth,
		 encrypted_snapshot_id=null,plan_type=excluded.plan_type,
		 message=null,updated_at=now()`,
		[userId, await seal(contents), planType],
	);
}

function externalTokens(auth: ManagedCodexAuth): CodexExternalTokens {
	return {
		accessToken: auth.tokens.access_token,
		chatgptAccountId: auth.tokens.account_id,
	};
}

/** Row lock makes refresh-token rotation single-writer across web/worker processes. */
export async function codexExternalTokens(
	userId: string,
	forceRefresh = false,
): Promise<CodexExternalTokens> {
	const client = await database().connect();
	try {
		await client.query("begin");
		const result = await client.query<{
			encrypted_codex_auth: string | null;
		}>(
			"select encrypted_codex_auth from agent_account where user_id=$1 and provider='codex' and status='connected' for update",
			[userId],
		);
		const row = result.rows[0];
		if (!row?.encrypted_codex_auth) {
			throw new Error("Connect Codex before starting this agent.");
		}
		let auth = managedAuth(JSON.parse(await unseal(row.encrypted_codex_auth)));
		if (forceRefresh || codexAccessTokenExpiresAt(auth) < Date.now() + 300_000) {
			auth = await refreshManagedCodexAuth(auth);
			await client.query(
				"update agent_account set encrypted_codex_auth=$2,updated_at=now() where user_id=$1 and provider='codex'",
				[userId, await seal(JSON.stringify(auth))],
			);
		}
		await client.query("commit");
		return externalTokens(auth);
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

async function refreshManagedCodexAuth(auth: ManagedCodexAuth) {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-codex-auth-"));
	const authPath = join(directory, "auth.json");
	try {
		await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
		await requestManagedRefresh(directory);
		const updated = managedAuth(JSON.parse(await readFile(authPath, "utf8")));
		if (codexAccessTokenExpiresAt(updated) < Date.now() + 60_000) {
			throw new Error("Codex login refresh failed; reconnect Codex.");
		}
		return updated;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function requestManagedRefresh(codexHome: string): Promise<void> {
	const child = spawn(process.env.CODEX_BIN || "codex", ["app-server"], {
		env: { ...process.env, CODEX_HOME: codexHome },
		stdio: ["pipe", "pipe", "ignore"],
	});
	const processFailure = new Promise<never>((_, reject) => {
		child.once("error", () =>
			reject(new Error("Codex is unavailable on the auth service.")),
		);
	});
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<number, (value: Record<string, unknown>) => void>();
	lines.on("line", (line) => {
		try {
			const message = JSON.parse(line) as Record<string, unknown>;
			if (typeof message.id === "number") pending.get(message.id)?.(message);
		} catch {
			// Ignore non-protocol output.
		}
	});
	const request = (id: number, method: string, params: unknown) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Codex login refresh timed out; reconnect Codex."));
			}, 25_000);
			pending.set(id, (message) => {
				clearTimeout(timeout);
				pending.delete(id);
				resolve(message);
			});
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	try {
		const initialized = await Promise.race([processFailure, request(1, "initialize", {
			clientInfo: { name: "ytimesy", title: "ytimesy", version: "0.0.0" },
			capabilities: { experimentalApi: true },
		})]);
		if (initialized.error) throw new Error("Codex login refresh failed; reconnect Codex.");
		child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
		const refreshed = await Promise.race([
			processFailure,
			request(2, "account/read", { refreshToken: true }),
		]);
		if (refreshed.error) throw new Error("Codex login refresh failed; reconnect Codex.");
	} finally {
		child.kill();
		lines.close();
	}
}
