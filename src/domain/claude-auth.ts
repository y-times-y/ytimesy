const ANTHROPIC_LOGIN_HOSTS = new Set([
	"claude.ai",
	"platform.claude.com",
	"console.anthropic.com",
]);

const LOGIN_URL_PATTERN =
	/https:\/\/(?:claude\.ai|platform\.claude\.com|console\.anthropic\.com)[^\s"'<>\\]+/gi;

export function parseAnthropicLoginUrl(output: string): string | null {
	const matches = output.match(LOGIN_URL_PATTERN) ?? [];
	for (const raw of matches) {
		const url = stripTrailingPunctuation(raw);
		if (isAnthropicAuthorizeUrl(url)) return url;
	}
	return null;
}

export function isAnthropicAuthorizeUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") return false;
		if (!ANTHROPIC_LOGIN_HOSTS.has(url.hostname)) return false;
		return url.pathname.includes("oauth") || url.pathname.includes("login");
	} catch {
		return false;
	}
}

export function claudeCliIsSignedIn(output: string): boolean {
	const text = output.trim();
	if (!text) return false;
	if (/\bnot logged in\b/i.test(text)) return false;
	if (/\blogin required\b/i.test(text)) return false;
	return (
		/\blogged in\b/i.test(text) ||
		/\blogin successful\b/i.test(text) ||
		/\bauthenticated\b/i.test(text)
	);
}

export function parseClaudeListedModels(output: string): readonly {
	readonly id: string;
	readonly label: string;
}[] {
	const trimmed = output.trim();
	if (!trimmed) return [];
	const fromJson = modelsFromJson(trimmed);
	if (fromJson.length > 0) return fromJson;
	return modelsFromCliLines(trimmed);
}

function modelsFromJson(output: string): readonly {
	readonly id: string;
	readonly label: string;
}[] {
	try {
		const parsed: unknown = JSON.parse(output);
		return listedModelsFromUnknown(parsed);
	} catch {
		const start = output.indexOf("[");
		const end = output.lastIndexOf("]");
		if (start < 0 || end <= start) return [];
		try {
			return listedModelsFromUnknown(JSON.parse(output.slice(start, end + 1)));
		} catch {
			return [];
		}
	}
}

function listedModelsFromUnknown(value: unknown): readonly {
	readonly id: string;
	readonly label: string;
}[] {
	const rows = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.models)
			? value.models
			: [];
	const models: { id: string; label: string }[] = [];
	for (const row of rows) {
		if (typeof row === "string" && row.trim()) {
			models.push({ id: row.trim(), label: row.trim() });
			continue;
		}
		if (!isRecord(row)) continue;
		const id =
			readString(row.id) ??
			readString(row.model) ??
			readString(row.slug) ??
			null;
		if (!id) continue;
		models.push({
			id,
			label: readString(row.label) ?? readString(row.name) ?? id,
		});
	}
	return models;
}

function modelsFromCliLines(output: string): readonly {
	readonly id: string;
	readonly label: string;
}[] {
	const models: { id: string; label: string }[] = [];
	const seen = new Set<string>();
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim().replace(/^\*\s*/, "");
		const withId = line.match(/^(.+?)\s+\(([^)]+)\)/);
		if (withId?.[1] && withId[2]) {
			const id = withId[2].trim();
			if (seen.has(id)) continue;
			seen.add(id);
			models.push({ id, label: withId[1].trim() });
			continue;
		}
		if (/^[a-z0-9][a-z0-9._:-]*$/i.test(line) && line.includes("-")) {
			if (seen.has(line)) continue;
			seen.add(line);
			models.push({ id: line, label: line });
		}
	}
	return models;
}

function stripTrailingPunctuation(value: string) {
	return value.replace(/[).,;]+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
