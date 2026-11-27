/**
 * A project's template snapshot (or the VM it was built from) can be gone at the
 * provider (production 2026-11-27: a chat of an old project retried a 404 for
 * 15 minutes and failed). The machine start then rebuilds the project's
 * environment once and retries, with a calm status, instead of repeating the 404.
 */
export const TEMPLATE_REBUILD_KIND = "template-missing-rebuild";

/** Detail carried by the retryable start failure raised while the rebuild runs. */
export const TEMPLATE_REBUILDING_DETAIL = "template-rebuilding";

/** Public text of that failure; matched by turn-interruption.ts as a start that passes. */
export const TEMPLATE_REBUILDING_MESSAGE =
	"The project's workspace environment is being rebuilt; your message is saved and continues when it is ready.";

/** A build this recent already answers the need; a second request would only add noise. */
export const TEMPLATE_REBUILD_COOLDOWN_MS = 5 * 60_000;

export function shouldRequestTemplateRebuild(input: {
	readonly runningBuild: boolean;
	readonly lastBuildStartedAt: Date | null;
	readonly now: Date;
}) {
	if (input.runningBuild) return false;
	return (
		!input.lastBuildStartedAt ||
		input.now.getTime() - input.lastBuildStartedAt.getTime() >=
			TEMPLATE_REBUILD_COOLDOWN_MS
	);
}

export function elapsedText(ms: number) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60
		? `${seconds} s`
		: `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The calm status line: what is happening, the build's current stage and how long it has run. */
export function preparingWorkspaceText(input: {
	readonly stage?: string | null;
	readonly elapsedMs?: number | null;
}) {
	const parts = [
		input.stage?.trim() || null,
		input.elapsedMs == null ? null : elapsedText(input.elapsedMs),
	].filter(Boolean);
	return `Preparing your workspace…${parts.length ? ` ${parts.join(" · ")}` : ""} A fresh environment is being built (usually 3 to 5 minutes); you do not need to do anything.`;
}

/** True for the retryable start failure raised while the project's environment is rebuilt (looks through causes). */
export function isTemplateRebuilding(cause: unknown, depth = 0): boolean {
	if (depth > 4 || !(cause instanceof Error)) return false;
	const detail = String((cause as { detail?: unknown }).detail ?? "");
	return (
		detail.startsWith(TEMPLATE_REBUILDING_DETAIL) ||
		isTemplateRebuilding(cause.cause, depth + 1)
	);
}
