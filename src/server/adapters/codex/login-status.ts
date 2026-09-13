export type ListedModel = {
	readonly id: string;
	readonly label: string;
};

export type CodexTurnResult = {
	readonly threadId: string;
	readonly modelId: string;
	readonly status: string;
	readonly text: string | null;
	readonly error: string | null;
};

export type SessionMessage = {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly text: string;
};

export type CodexLoginStatus =
	| { readonly stage: "starting"; readonly codexVersion: string | null }
	| {
			readonly stage: "awaiting_device_code";
			readonly loginId: string;
			readonly verificationUrl: string;
			readonly userCode: string;
			readonly codexVersion: string | null;
	  }
	| {
			readonly stage: "authenticated";
			readonly authMode: "chatgpt";
			readonly planType: string | null;
			readonly models: readonly ListedModel[];
			readonly turn: CodexTurnResult | null;
			readonly messages: readonly SessionMessage[];
			readonly codexVersion: string | null;
	  }
	| {
			readonly stage: "failed";
			readonly message: string;
			readonly stageDetail?: string;
	  }
	| { readonly stage: "missing" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseCodexLoginStatus(
	contents: string | null,
): CodexLoginStatus {
	if (!contents) return { stage: "missing" };
	try {
		const parsed: unknown = JSON.parse(contents);
		if (!isRecord(parsed))
			return { stage: "failed", message: "Login status was not an object" };
		const stage = readString(parsed.stage);
		if (stage === "starting") {
			return {
				stage: "starting",
				codexVersion: readString(parsed.codexVersion) ?? null,
			};
		}
		if (stage === "awaiting_device_code") {
			const loginId = readString(parsed.loginId);
			const verificationUrl = readString(parsed.verificationUrl);
			const userCode = readString(parsed.userCode);
			if (!loginId || !verificationUrl || !userCode) {
				return {
					stage: "failed",
					message: "Device-code status was missing login fields",
				};
			}
			return {
				stage: "awaiting_device_code",
				loginId,
				verificationUrl,
				userCode,
				codexVersion: readString(parsed.codexVersion) ?? null,
			};
		}
		if (stage === "authenticated") {
			return {
				stage: "authenticated",
				authMode: "chatgpt",
				planType: readString(parsed.planType) ?? null,
				models: listedModels(parsed.models),
				turn: turnResult(parsed.turn),
				messages: sessionMessages(parsed.messages),
				codexVersion: readString(parsed.codexVersion) ?? null,
			};
		}
		if (stage === "failed") {
			return {
				stage: "failed",
				message: readString(parsed.message) ?? "Codex login failed",
				stageDetail: readString(parsed.stageDetail),
			};
		}
		return {
			stage: "failed",
			message: `Unknown Codex login stage: ${stage ?? "absent"}`,
		};
	} catch (cause) {
		return {
			stage: "failed",
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

function listedModels(value: unknown): readonly ListedModel[] {
	if (!Array.isArray(value)) return [];
	const models: ListedModel[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const id = readString(row.id);
		if (!id) continue;
		models.push({ id, label: readString(row.label) ?? id });
	}
	return models;
}

function sessionMessages(value: unknown): readonly SessionMessage[] {
	if (!Array.isArray(value)) return [];
	const messages: SessionMessage[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const role = readString(row.role);
		const text = readString(row.text);
		if (role !== "user" && role !== "assistant") continue;
		if (!text) continue;
		messages.push({
			id: readString(row.id) ?? `${role}:${text}`,
			role,
			text,
		});
	}
	return messages;
}

function turnResult(value: unknown): CodexTurnResult | null {
	if (!isRecord(value)) return null;
	const threadId = readString(value.threadId);
	const modelId = readString(value.modelId);
	const status = readString(value.status);
	if (!threadId || !modelId || !status) return null;
	return {
		threadId,
		modelId,
		status,
		text: readString(value.text) ?? null,
		error: readString(value.error) ?? null,
	};
}

export function publicLoginStatus(status: CodexLoginStatus) {
	if (status.stage === "awaiting_device_code") {
		return {
			stage: status.stage,
			verificationUrl: status.verificationUrl,
			userCode: status.userCode,
			codexVersion: status.codexVersion,
		};
	}
	if (status.stage === "authenticated") {
		return {
			stage: status.stage,
			authMode: status.authMode,
			planType: status.planType,
			modelCount: status.models.length,
			models: status.models,
			turn: status.turn,
			messages: status.messages,
			codexVersion: status.codexVersion,
		};
	}
	return status;
}

export const PREFERRED_CODEX_MODEL_ID = "gpt-5.3-codex-spark";

export function chooseListedModelId(
	models: readonly { readonly id: string; readonly isDefault?: boolean }[],
	preferredId = PREFERRED_CODEX_MODEL_ID,
): string | null {
	if (models.some((model) => model.id === preferredId)) return preferredId;
	const listedDefault = models.find((model) => model.isDefault);
	if (listedDefault) return listedDefault.id;
	return models[0]?.id ?? null;
}

export function isChatgptCliLoginOutput(output: string): boolean {
	return output.includes("Logged in using ChatGPT");
}
