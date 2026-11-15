import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	init: vi.fn(),
	capture: vi.fn(),
	identify: vi.fn(),
	reset: vi.fn(),
	get_property: vi.fn((): string | undefined => undefined),
	startSessionRecording: vi.fn(),
	stopSessionRecording: vi.fn(),
	sessionRecordingStarted: vi.fn(() => false),
}));
function storage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}
vi.mock("posthog-js", () => ({ default: sdk }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubGlobal("window", {});
	vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test");
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("PostHog client", () => {
	it("initializes once and filters outbound SDK payloads without breaking ingestion", async () => {
		const { captureAnalytics } = await import("./client");
		captureAnalytics("app_viewed", { surface: "workspace" });
		captureAnalytics("inspector_opened", { panel: "files" });
		await vi.waitFor(() => expect(sdk.capture).toHaveBeenCalledTimes(2));
		expect(sdk.init).toHaveBeenCalledTimes(1);
		const config = sdk.init.mock.calls[0][1];
		expect(config).toMatchObject({
			autocapture: false,
			capture_pageview: "history_change",
			capture_pageleave: true,
			// Replay starts per user (setAnalyticsUser), never at init.
			disable_session_recording: true,
			enable_recording_console_log: false,
			capture_performance: { web_vitals: true, network_timing: false },
			capture_exceptions: {
				capture_unhandled_errors: true,
				capture_unhandled_rejections: true,
				capture_console_errors: false,
			},
			respect_dnt: true,
		});
		expect(
			config.before_send({
				event: "app_viewed",
				properties: {
					surface: "workspace",
					distinct_id: "anonymous",
					$current_url: "private",
					prompt: "secret",
					token: "wrong",
					$lib: "web",
					$lib_version: "1.435.6",
					$lib_custom_api_host: "/r",
					$browser: "Chrome",
				},
			}).properties,
		).toEqual({
			surface: "workspace",
			distinct_id: "anonymous",
			token: "phc_test",
			$process_person_profile: undefined,
			$geoip_disable: true,
			$session_id: undefined,
			$window_id: undefined,
			$lib: "web",
			$lib_version: "1.435.6",
			$lib_custom_api_host: "/r",
			environment: "development",
		});
		const snapshot = [{ type: 2, timestamp: 1, data: { node: {} } }];
		expect(
			config.before_send({
				event: "$snapshot",
				properties: { $snapshot_data: snapshot, $current_url: "private" },
			}).properties,
		).toMatchObject({ $snapshot_data: snapshot });
		expect(
			config.before_send({ event: "$snapshot", properties: {} }),
		).toBeNull();
	});
	it("masks text and attributes and excludes private surfaces and network payloads", async () => {
		const { replayPrivacy } = await import("./replay-privacy");
		const div = { tagName: "DIV" } as Element;
		const link = { tagName: "LINK" } as Element;
		expect(replayPrivacy.maskAllInputs).toBe(true);
		expect(replayPrivacy.maskTextSelector).toBe("*");
		for (const selector of [
			".composer-input",
			".inspector-frame",
			".xterm",
			"canvas",
			"iframe",
			"input",
		])
			expect(replayPrivacy.blockSelector).toContain(selector);
		for (const attribute of [
			"href",
			"src",
			"title",
			"aria-label",
			"data-path",
			"value",
		])
			expect(replayPrivacy.maskAttributeFn?.(attribute, "private", div)).toBe(
				"",
			);
		expect(
			replayPrivacy.maskAttributeFn?.("class", "sidebar-toolbar", div),
		).toBe("sidebar-toolbar");
		// The replay keeps the app's styles, or it plays as a gray page.
		expect(replayPrivacy.maskAttributeFn?.("style", "width: 4px", div)).toBe(
			"width: 4px",
		);
		expect(
			replayPrivacy.maskAttributeFn?.("href", "/assets/styles.css", link),
		).toBe("/assets/styles.css");
		expect(replayPrivacy.maskAttributeFn?.("rel", "stylesheet", link)).toBe(
			"stylesheet",
		);
		expect(
			replayPrivacy.maskCapturedNetworkRequestFn?.({} as never),
		).toBeNull();
		expect(replayPrivacy.captureCanvas?.recordCanvas).toBe(false);
		expect(replayPrivacy.recordHeaders).toBe(false);
		expect(replayPrivacy.recordBody).toBe(false);
	});
	it("records masked sessions while the page allows it, and stops when it no longer does", async () => {
		vi.stubGlobal("localStorage", storage());
		const { setAnalyticsUser } = await import("./client");
		setAnalyticsUser("user-id", { replay: true });
		await vi.waitFor(() =>
			expect(sdk.startSessionRecording).toHaveBeenCalledTimes(1),
		);
		sdk.sessionRecordingStarted.mockReturnValue(true);
		setAnalyticsUser(null, { replay: false });
		await vi.waitFor(() =>
			expect(sdk.stopSessionRecording).toHaveBeenCalledTimes(1),
		);
		sdk.sessionRecordingStarted.mockReturnValue(false);
	});
	it("records a signed-out visitor where the page allows it", async () => {
		vi.stubGlobal("localStorage", storage());
		const { setAnalyticsUser } = await import("./client");
		setAnalyticsUser(null, { replay: true });
		await vi.waitFor(() =>
			expect(sdk.startSessionRecording).toHaveBeenCalledTimes(1),
		);
		expect(sdk.identify).not.toHaveBeenCalled();
	});
	it("never records in opt-in regions, under Do Not Track or Global Privacy Control, or after a decline", async () => {
		vi.stubGlobal("localStorage", storage());
		let client = await import("./client");
		client.setAnalyticsUser("user-id", { replay: false });
		await vi.waitFor(() => expect(sdk.identify).toHaveBeenCalled());
		vi.resetModules();
		vi.stubGlobal("navigator", { doNotTrack: "1" });
		client = await import("./client");
		client.setAnalyticsUser("user-id", { replay: true });
		await vi.waitFor(() => expect(sdk.identify).toHaveBeenCalledTimes(2));
		vi.resetModules();
		vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: true });
		client = await import("./client");
		client.setAnalyticsUser("user-id", { replay: true });
		await vi.waitFor(() => expect(sdk.identify).toHaveBeenCalledTimes(3));
		vi.resetModules();
		vi.stubGlobal("navigator", { doNotTrack: "0" });
		vi.stubGlobal(
			"localStorage",
			storage({ "ytimesy.replay-consent": "declined" }),
		);
		client = await import("./client");
		client.setAnalyticsUser("user-id", { replay: true });
		await vi.waitFor(() => expect(sdk.identify).toHaveBeenCalledTimes(4));
		expect(sdk.startSessionRecording).not.toHaveBeenCalled();
	});
	it("turns replay off at once from Privacy choices, and back on", async () => {
		const store = storage();
		vi.stubGlobal("localStorage", store);
		const client = await import("./client");
		client.setAnalyticsUser(null, { replay: true });
		await vi.waitFor(() =>
			expect(sdk.startSessionRecording).toHaveBeenCalledTimes(1),
		);
		sdk.sessionRecordingStarted.mockReturnValue(true);
		client.setReplayChoice("declined");
		await vi.waitFor(() =>
			expect(sdk.stopSessionRecording).toHaveBeenCalledTimes(1),
		);
		expect(store.getItem("ytimesy.replay-consent")).toBe("declined");
		sdk.sessionRecordingStarted.mockReturnValue(false);
		client.setReplayChoice("allowed");
		await vi.waitFor(() =>
			expect(sdk.startSessionRecording).toHaveBeenCalledTimes(2),
		);
	});
	it("identifies by internal ID only and resets on logout", async () => {
		const { setAnalyticsUser } = await import("./client");
		setAnalyticsUser("user-id", { replay: false });
		sdk.get_property.mockReturnValue("identified");
		setAnalyticsUser(null, { replay: false });
		await vi.waitFor(() => expect(sdk.reset).toHaveBeenCalledTimes(1));
		expect(sdk.identify).toHaveBeenCalledExactlyOnceWith("user-id");
		sdk.get_property.mockReturnValue(undefined);
	});
	it("keeps a signed-out visitor's anonymous ID across page loads", async () => {
		const { setAnalyticsUser } = await import("./client");
		sdk.get_property.mockReturnValue("anonymous");
		setAnalyticsUser(null, { replay: false });
		await vi.waitFor(() =>
			expect(sdk.get_property).toHaveBeenCalledWith("$user_state"),
		);
		expect(sdk.reset).not.toHaveBeenCalled();
		sdk.get_property.mockReturnValue(undefined);
	});
	it("does nothing during SSR or when unconfigured", async () => {
		vi.stubGlobal("window", undefined);
		const { captureAnalytics } = await import("./client");
		captureAnalytics("app_viewed", { surface: "workspace" });
		vi.stubGlobal("window", {});
		vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
		captureAnalytics("app_viewed", { surface: "workspace" });
		await Promise.resolve();
		expect(sdk.init).not.toHaveBeenCalled();
	});
	it("swallows SDK failures without breaking user actions", async () => {
		sdk.init.mockImplementationOnce(() => {
			throw new Error("offline");
		});
		const { captureAnalytics } = await import("./client");
		expect(() =>
			captureAnalytics("app_viewed", { surface: "workspace" }),
		).not.toThrow();
		await Promise.resolve();
		expect(sdk.capture).not.toHaveBeenCalled();
	});
});
