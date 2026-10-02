import type { PostHogConfig } from "posthog-js";

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
