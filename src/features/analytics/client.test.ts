import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	init: vi.fn(),
	capture: vi.fn(),
	identify: vi.fn(),
	reset: vi.fn(),
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
			capture_pageview: false,
			capture_pageleave: false,
			// Replay is off until the visitor accepts it.
			disable_session_recording: true,
			enable_recording_console_log: false,
			capture_performance: false,
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
		expect(replayPrivacy.maskAllInputs).toBe(true);
		expect(replayPrivacy.maskTextSelector).toBe("*");
		for (const selector of [
			".session-timeline",
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
			expect(replayPrivacy.maskAttributeFn?.(attribute, "private")).toBe("");
		expect(replayPrivacy.maskAttributeFn?.("class", "sidebar-toolbar")).toBe(
			"sidebar-toolbar",
		);
		expect(
			replayPrivacy.maskCapturedNetworkRequestFn?.({} as never),
		).toBeNull();
		expect(replayPrivacy.captureCanvas?.recordCanvas).toBe(false);
		expect(replayPrivacy.recordHeaders).toBe(false);
		expect(replayPrivacy.recordBody).toBe(false);
	});
	it("records sessions only after the visitor accepts, and stops on decline", async () => {
		vi.stubGlobal("localStorage", storage());
		const { captureAnalytics } = await import("./client");
		const { saveReplayConsent } = await import("./replay-consent");
		captureAnalytics("app_viewed", { surface: "workspace" });
		await vi.waitFor(() => expect(sdk.capture).toHaveBeenCalled());
		expect(sdk.startSessionRecording).not.toHaveBeenCalled();
		saveReplayConsent("accepted");
		expect(sdk.startSessionRecording).toHaveBeenCalledTimes(1);
		sdk.sessionRecordingStarted.mockReturnValue(true);
		saveReplayConsent("declined");
		expect(sdk.stopSessionRecording).toHaveBeenCalledTimes(1);
		sdk.sessionRecordingStarted.mockReturnValue(false);
	});
	it("resumes recording on a later visit only for a stored acceptance", async () => {
		vi.stubGlobal(
			"localStorage",
			storage({ "ytimesy.replay-consent": "accepted" }),
		);
		const { captureAnalytics } = await import("./client");
		captureAnalytics("app_viewed", { surface: "workspace" });
		await vi.waitFor(() =>
			expect(sdk.startSessionRecording).toHaveBeenCalledTimes(1),
		);
	});
	it("identifies by internal ID only and resets on logout", async () => {
		const { setAnalyticsUser } = await import("./client");
		setAnalyticsUser("user-id");
		setAnalyticsUser(null);
		await vi.waitFor(() => expect(sdk.reset).toHaveBeenCalledTimes(1));
		expect(sdk.identify).toHaveBeenCalledExactlyOnceWith("user-id");
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
