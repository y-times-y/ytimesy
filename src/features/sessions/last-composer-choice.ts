import type { AgentProviderId } from "#/domain/agent-provider";

/**
 * The model the person last chose in the composer, kept in this browser so a
 * reload opens a new chat on it, not on whatever the catalog lists first.
 */
const KEY = "ytimesy-composer-choice";

export type ComposerChoice = {
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readComposerChoice(
	storage: StorageLike | undefined = browserStorage(),
): ComposerChoice | null {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
		if (!parsed || typeof parsed !== "object") return null;
		const { harnessId, modelId } = parsed as Record<string, unknown>;
		if (harnessId !== "codex" && harnessId !== "api") return null;
		if (typeof modelId !== "string" || !modelId.trim()) return null;
		return { harnessId, modelId };
	} catch {
		return null;
	}
}

export function writeComposerChoice(
	choice: ComposerChoice,
	storage: StorageLike | undefined = browserStorage(),
) {
	try {
		storage?.setItem(KEY, JSON.stringify(choice));
	} catch {
		// Private mode or a full quota: the choice is just not remembered.
	}
}

function browserStorage(): StorageLike | undefined {
	return typeof window === "undefined" ? undefined : window.localStorage;
}
