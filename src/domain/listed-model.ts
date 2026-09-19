export type ListedModel = {
	readonly id: string;
	readonly label: string;
	readonly notice?: string;
	readonly supportsFastMode?: boolean;
};

export function listedModelSupportsFastMode(row: {
	readonly supportsFastMode?: unknown;
	readonly fast?: unknown;
}): boolean {
	return row.supportsFastMode === true || row.fast === true;
}

export type ListedModelPreference = {
	readonly lastUsedId?: string;
	readonly excludedIds?: readonly string[];
};

export type ListedModelSessionHint = {
	readonly harness: string;
	readonly listedModelId: string | null;
	readonly items: unknown;
};

export function listedModelRestrictedByProvider(message: string): boolean {
	return /\[user_blocked\]|access has been restricted due to repeated policy/i.test(
		message,
	);
}

export function sessionListedModelIsBlocked(
	listedModelId: string | null | undefined,
	items: unknown,
): boolean {
	const id = listedModelId?.trim();
	if (!id) return false;
	const rows = Array.isArray(items) ? items : [];
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const item = rows[index];
		if (!item || typeof item !== "object") continue;
		const record = item as {
			kind?: unknown;
			message?: unknown;
			text?: unknown;
		};
		if (
			record.kind === "error" &&
			typeof record.message === "string" &&
			listedModelRestrictedByProvider(record.message)
		) {
			return true;
		}
		if (record.kind === "agentMessage" && typeof record.text === "string") {
			if (listedModelRestrictedByProvider(record.text)) return true;
			if (record.text.trim()) return false;
		}
	}
	return false;
}

export function listedModelPreferenceFromSessions(input: {
	readonly harness: string;
	readonly sessions: readonly ListedModelSessionHint[];
}): {
	readonly listedModelId: string;
	readonly blockedListedModelIds: readonly string[];
} {
	const own = input.sessions.filter(
		(session) => session.harness === input.harness,
	);
	const blockedListedModelIds = [
		...new Set(
			own.flatMap((session) => {
				const id = session.listedModelId?.trim();
				if (!id) return [];
				return sessionListedModelIsBlocked(id, session.items) ? [id] : [];
			}),
		),
	];
	const listedModelId =
		own
			.map((session) => session.listedModelId?.trim() ?? "")
			.find((id) => id && !blockedListedModelIds.includes(id)) ?? "";
	return { listedModelId, blockedListedModelIds };
}

export function listedModelDisplayName(modelId: string) {
	const id = modelId.trim();
	if (!id) return "";
	const slash = id.lastIndexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : id;
}

export function preferredListedModelId(
	models: readonly { readonly id: string }[],
	options?: ListedModelPreference,
): string {
	const excluded = new Set(options?.excludedIds ?? []);
	const listed = models.filter((model) => model.id && !excluded.has(model.id));
	const lastUsed = options?.lastUsedId?.trim();
	if (lastUsed && !excluded.has(lastUsed)) {
		if (listed.length === 0 || listed.some((model) => model.id === lastUsed)) {
			return lastUsed;
		}
	}
	return (
		listed.find((model) => model.id === "gpt-5.3-codex-spark")?.id ??
		listed.find(
			(model) =>
				model.id.startsWith("opencode/") && model.id.includes("muse-spark-1.3"),
		)?.id ??
		listed.find(
			(model) => model.id.startsWith("opencode/") && model.id.includes("spark"),
		)?.id ??
		listed.find(
			(model) =>
				model.id.startsWith("opencode/") &&
				(model.id.endsWith("-free") || model.id.includes("contributor-free")),
		)?.id ??
		listed[0]?.id ??
		""
	);
}

export function submittedListedModelId(
	requested: string,
	models: readonly { readonly id: string }[],
	options?: ListedModelPreference,
): string {
	const trimmed = requested.trim();
	const excluded = new Set(options?.excludedIds ?? []);
	if (
		trimmed &&
		!excluded.has(trimmed) &&
		models.some((model) => model.id === trimmed)
	) {
		return trimmed;
	}
	return preferredListedModelId(models, options);
}

export function composerModelIdForCatalog(input: {
	readonly requestedId: string;
	readonly catalog: readonly { readonly id: string }[];
	readonly lastUsedForCatalog?: string;
	readonly excludedIds?: readonly string[];
}): string {
	const excluded = new Set(input.excludedIds ?? []);
	const listed = input.catalog.filter(
		(model) => model.id && !excluded.has(model.id),
	);
	const requested = input.requestedId.trim();
	if (requested && listed.some((model) => model.id === requested)) {
		return requested;
	}
	const remembered = input.lastUsedForCatalog?.trim() ?? "";
	if (remembered && listed.some((model) => model.id === remembered)) {
		return remembered;
	}
	if (listed.length === 0) return "";
	return preferredListedModelId(listed, { excludedIds: input.excludedIds });
}
