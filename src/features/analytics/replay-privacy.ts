import type { PostHogConfig } from "posthog-js";
import { replaySafeUrl } from "#/domain/redact-secrets";

/** Block private application surfaces before rrweb serializes their DOM. */
export const replayPrivacy: PostHogConfig["session_recording"] = {
	maskAllInputs: true,
	maskTextSelector: "*",
	slimDOMOptions: "all",
	blockSelector: [
		"[data-replay-private]",
		".session-timeline",
		".composer-input",
		".inspector-frame",
		".sidebar-projects",
		".session-title-copy",
		".desktop-stage-rfb",
		".cm-editor",
		".xterm",
		"pre",
		"code",
		"input",
		"textarea",
		"select",
		"[contenteditable]",
		"img",
		"canvas",
		"video",
		"iframe",
	].join(","),
	maskAttributeFn: (name, value) =>
		["class", "role", "type", "aria-expanded", "disabled"].includes(name)
			? value
			: "",
	captureCanvas: { recordCanvas: false },
	recordCrossOriginIframes: false,
	recordHeaders: false,
	recordBody: false,
	captureJsonLd: false,
	maskCapturedNetworkRequestFn: () => null,
};

/**
 * Replay events without full URLs: rrweb meta events (type 4) carry the page
 * href, which can hold tokens (e.g. /auth/reset-password?token=). Query and
 * fragment are dropped; /auth/* pages are dropped entirely.
 */
export function replaySnapshotData(data: unknown[]): unknown[] {
	return data.flatMap((item) => {
		if (!item || typeof item !== "object") return [item];
		const event = item as { type?: unknown; data?: { href?: unknown } };
		if (event.type !== 4 || typeof event.data?.href !== "string") return [item];
		const href = replaySafeUrl(event.data.href);
		return href === null ? [] : [{ ...event, data: { ...event.data, href } }];
	});
}
