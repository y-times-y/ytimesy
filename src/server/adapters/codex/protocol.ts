import type { AgentConnection } from "#/domain/agent-connection";

export type JsonRpcMessage = {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code?: number; readonly message?: string };
};

export type CodexProbeReport = {
	readonly ok: boolean;
	readonly stage: string;
	readonly error?: string;
	readonly codexVersion?: string | null;
	readonly initialize?: unknown;
	readonly account?: unknown;
	readonly login?: unknown;
	readonly notes?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseCodexProbeReport(stdout: string): CodexProbeReport {
	const marker = "YTIMESY_PROOF=";
	const line = stdout
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith(marker));
	if (!line) {
		return {
			ok: false,
			stage: "parse",
			error: "Codex probe did not emit a YTIMESY_PROOF result",
		};
	}
	try {
		const parsed: unknown = JSON.parse(line.slice(marker.length));
		if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
			return {
				ok: false,
				stage: "parse",
				error: "Codex probe result was not an object with ok",
			};
		}
		return {
			ok: parsed.ok,
			stage: readString(parsed.stage) ?? "unknown",
			error: readString(parsed.error),
			codexVersion: readString(parsed.codexVersion) ?? null,
			initialize: parsed.initialize,
			account: parsed.account,
			login: parsed.login,
			notes: Array.isArray(parsed.notes)
				? parsed.notes.filter(
						(note): note is string => typeof note === "string",
					)
				: [],
		};
	} catch (cause) {
		return {
			ok: false,
			stage: "parse",
			error: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

export function agentConnectionFromProbe(
	report: CodexProbeReport,
): AgentConnection {
	if (!report.ok) {
		return {
			status: "failed",
			provider: "codex",
			message: report.error ?? `Codex probe failed at ${report.stage}`,
		};
	}

	const authenticated = providerAccount(report.account);
	if (authenticated) return authenticated;

	const pending = deviceCodeLogin(report.login);
	if (pending) return pending;

	if (isRecord(report.login) && readString(report.login.type) === "apiKey") {
		return {
			status: "failed",
			provider: "codex",
			message: "Codex is waiting for an API key or ChatGPT sign-in.",
		};
	}

	return {
		status: "disconnected",
	};
}

function providerAccount(value: unknown): AgentConnection | undefined {
	if (!isRecord(value)) return undefined;
	const account = value.account;
	if (!isRecord(account)) return undefined;
	if (account.type === "chatgpt") {
		return {
			status: "authenticated",
			provider: "codex",
			authMode: "chatgpt",
			planType: readString(account.planType) ?? null,
			email: readString(account.email) ?? null,
		};
	}
	if (account.type === "apiKey" || account.type === "api") {
		return {
			status: "authenticated",
			provider: "codex",
			authMode: "apikey",
			planType: readString(account.planType) ?? null,
			email: null,
		};
	}
	return undefined;
}

function deviceCodeLogin(value: unknown): AgentConnection | undefined {
	if (!isRecord(value) || value.type !== "chatgptDeviceCode") return undefined;
	const loginId = readString(value.loginId);
	const verificationUrl = readString(value.verificationUrl);
	const userCode = readString(value.userCode);
	if (!loginId || !verificationUrl || !userCode) {
		return {
			status: "failed",
			provider: "codex",
			message:
				"chatgptDeviceCode response was missing loginId, verificationUrl, or userCode",
		};
	}
	return {
		status: "awaiting_device_code",
		provider: "codex",
		loginId,
		verificationUrl,
		userCode,
	};
}
