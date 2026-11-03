import type { PostHogConfig } from "posthog-js";
import { replaySafeUrl } from "#/domain/redact-secrets";

const REPLAY_ATTRIBUTES = new Set([
	"class",
	"role",
	"type",
	"aria-expanded",
	"disabled",
	"style",
	"_cssText",
]);
const STYLESHEET_LINK_ATTRIBUTES = new Set(["rel", "href", "media", "as"]);

/** Block private application surfaces before rrweb serializes their DOM. */
export const replayPrivacy: PostHogConfig["session_recording"] = {
	maskAllInputs: true,
	maskTextSelector: "*",
	slimDOMOptions: "all",
	blockSelector: [
		// Text is masked everywhere (maskTextSelector), so the chat, sidebar and
		// titles stay visible as layout; what could show content even masked
		// (code, editors, terminals, fields, media, frames) is blocked whole.
		"[data-replay-private]",
		".composer-input",
		".inspector-frame",
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
	// Attributes can carry content (title, alt, href, data-*), so only layout
	// ones pass. The app's own stylesheet links and inline styles must pass
	// too, or the replay plays unstyled (a gray page).
	maskAttributeFn: (name, value, element) =>
		REPLAY_ATTRIBUTES.has(name) ||
		(element?.tagName === "LINK" && STYLESHEET_LINK_ATTRIBUTES.has(name))
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
