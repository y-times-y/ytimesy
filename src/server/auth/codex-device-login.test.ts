import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { database } from "../adapters/database";
import {
	advanceCodexDeviceLogin,
	readCodexDeviceLogin,
	startCodexDeviceLogin,
} from "./codex-device-login";
import { seal, unseal } from "./token-vault";

vi.mock("../adapters/database", () => ({ database: vi.fn() }));
vi.mock("./token-vault", () => ({ seal: vi.fn(), unseal: vi.fn() }));

type Row = {
	status: string;
	encrypted_codex_auth: string | null;
	encrypted_device_login: string | null;
	plan_type?: string | null;
};
let row: Row | undefined;
const statements: string[] = [];

function jwt(claims: Record<string, unknown>) {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}
const accessToken = jwt({
	exp: Math.floor(Date.now() / 1000) + 10 * 86_400,
	"https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
});
const idToken = jwt({
	"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
});

// A one-row stand-in for agent_account that understands the module's statements.
function query(sql: string, params: unknown[] = []) {
	statements.push(sql);
	if (sql.startsWith("select"))
		return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
	if (sql.startsWith("insert")) {
		row = {
			status: row?.status ?? "disconnected",
			encrypted_codex_auth: row?.encrypted_codex_auth ?? null,
			encrypted_device_login: params[1] as string,
		};
	} else if (sql.includes("status='connected'")) {
		row = {
			status: "connected",
			encrypted_codex_auth: params[1] as string,
			encrypted_device_login: null,
			plan_type: params[2] as string,
		};
	} else if (sql.includes("encrypted_device_login=null") && row) {
		row = { ...row, encrypted_device_login: null };
	} else if (sql.includes("encrypted_device_login=$2") && row) {
		row = { ...row, encrypted_device_login: params[1] as string };
	}
	return { rows: [], rowCount: 1 };
}

beforeEach(() => {
	row = undefined;
	statements.length = 0;
	vi.mocked(seal).mockImplementation(async (value) => `sealed:${value}`);
	vi.mocked(unseal).mockImplementation(async (value) =>
		value.replace(/^sealed:/, ""),
	);
	vi.mocked(database).mockReturnValue({
		query: vi.fn(async (sql: string, params?: unknown[]) => query(sql, params)),
		connect: vi.fn(async () => ({
			query: vi.fn(async (sql: string, params?: unknown[]) =>
				query(sql, params),
			),
			release: vi.fn(),
		})),
	} as never);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function issuer(
	responses: Record<string, () => Response>,
): ReturnType<typeof vi.fn> {
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const path = new URL(String(input)).pathname;
		const respond = responses[path];
		if (!respond) throw new Error(`Unexpected request to ${path}`);
		return respond();
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

const userCode = () =>
	Response.json({
		device_auth_id: "device-1",
		user_code: "ABCD-12345",
		interval: "5",
	});

it("starts a sign-in on the server and shows the code without a VM", async () => {
	issuer({ "/api/accounts/deviceauth/usercode": userCode });
	expect(await startCodexDeviceLogin("user")).toEqual({
		status: "pending",
		userCode: "ABCD-12345",
		verificationUrl: "https://auth.openai.com/codex/device",
	});
	expect(row?.encrypted_device_login).toMatch(/^sealed:/);
	expect(await readCodexDeviceLogin("user")).toMatchObject({
		status: "pending",
	});
});

it("reuses a pending sign-in instead of issuing a second code", async () => {
	const fetch = issuer({ "/api/accounts/deviceauth/usercode": userCode });
	await startCodexDeviceLogin("user");
	await startCodexDeviceLogin("user");
	expect(fetch).toHaveBeenCalledOnce();
});

it("waits while unapproved and polls no faster than the issuer's interval", async () => {
	vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
	const fetch = issuer({
		"/api/accounts/deviceauth/usercode": userCode,
		"/api/accounts/deviceauth/token": () =>
			Response.json({ error: "pending" }, { status: 404 }),
	});
	await startCodexDeviceLogin("user");
	expect(await advanceCodexDeviceLogin("user")).toMatchObject({
		status: "pending",
	});
	expect(await advanceCodexDeviceLogin("user")).toMatchObject({
		status: "pending",
	});
	expect(fetch).toHaveBeenCalledTimes(2);
	vi.setSystemTime(1_000_000 + 5_000);
	await advanceCodexDeviceLogin("user");
	expect(fetch).toHaveBeenCalledTimes(3);
});

it("exchanges an approved code and stores the login where turns read it", async () => {
	const fetch = issuer({
		"/api/accounts/deviceauth/usercode": userCode,
		"/api/accounts/deviceauth/token": () =>
			Response.json({
				authorization_code: "code-1",
				code_challenge: "challenge",
				code_verifier: "verifier-1",
			}),
		"/oauth/token": () =>
			Response.json({
				id_token: idToken,
				access_token: accessToken,
				refresh_token: "refresh-1",
			}),
	});
	await startCodexDeviceLogin("user");
	expect(await advanceCodexDeviceLogin("user")).toEqual({
		status: "connected",
	});
	const exchange = fetch.mock.calls.find(([url]) =>
		String(url).endsWith("/oauth/token"),
	)?.[1] as RequestInit;
	expect(
		Object.fromEntries(new URLSearchParams(String(exchange.body))),
	).toEqual({
		grant_type: "authorization_code",
		code: "code-1",
		redirect_uri: "https://auth.openai.com/deviceauth/callback",
		client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
		code_verifier: "verifier-1",
	});
	expect(row?.status).toBe("connected");
	expect(row?.plan_type).toBe("plus");
	expect(row?.encrypted_device_login).toBeNull();
	const stored = JSON.parse(String(row?.encrypted_codex_auth).slice(7));
	expect(stored).toEqual({
		auth_mode: "chatgpt",
		tokens: {
			id_token: idToken,
			access_token: accessToken,
			refresh_token: "refresh-1",
			account_id: "account-1",
		},
	});
	expect(await advanceCodexDeviceLogin("user")).toEqual({
		status: "connected",
	});
});

it("clears an expired code and asks the user to sign in again", async () => {
	vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
	issuer({ "/api/accounts/deviceauth/usercode": userCode });
	await startCodexDeviceLogin("user");
	vi.setSystemTime(1_000_000 + 16 * 60_000);
	expect(await advanceCodexDeviceLogin("user")).toEqual({
		status: "failed",
		message: "The ChatGPT sign-in code expired. Sign in again.",
	});
	expect(row?.encrypted_device_login).toBeNull();
	expect(await readCodexDeviceLogin("user")).toEqual({ status: "none" });
});

it("does not expose issuer errors when a login is refused", async () => {
	issuer({
		"/api/accounts/deviceauth/usercode": userCode,
		"/api/accounts/deviceauth/token": () =>
			new Response("private diagnostics", { status: 500 }),
	});
	await startCodexDeviceLogin("user");
	const result = await advanceCodexDeviceLogin("user");
	expect(result).toEqual({
		status: "failed",
		message: "ChatGPT sign-in was not approved. Sign in again.",
	});
	expect(row?.status).toBe("disconnected");
});
