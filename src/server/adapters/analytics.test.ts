import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	captureImmediate: vi.fn().mockResolvedValue(undefined),
	init: vi.fn(),
}));
vi.mock("posthog-node", () => ({
	PostHog: class {
		constructor(...args: unknown[]) {
			sdk.init(...args);
		}
		captureImmediate = sdk.captureImmediate;
	},
}));
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
});
afterEach(() => vi.unstubAllEnvs());

it("captures allowlisted metadata with stable identity, never private input", async () => {
	const { captureServerAnalytics } = await import("./analytics");
	const identity = { key: "private/repository", timestamp: new Date(1234) };
	const properties = {
		runtime: "codex" as const,
		role: "builder" as const,
		prompt: "PRIVATE",
		api_key: "PRIVATE",
	};
	await captureServerAnalytics("user-id", "turn_started", properties, identity);
	await captureServerAnalytics("user-id", "turn_started", properties, identity);
	const sent = sdk.captureImmediate.mock.calls[0][0];
	expect(sent).toMatchObject({
		distinctId: "user-id",
		event: "turn_started",
		timestamp: identity.timestamp,
	});
	expect(sent.uuid).toBe(sdk.captureImmediate.mock.calls[1][0].uuid);
	expect(sent.uuid).toMatch(
		/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
	);
	expect(JSON.stringify(sent)).not.toContain("PRIVATE");
	expect(JSON.stringify(sent)).not.toContain(identity.key);
	expect(sdk.init.mock.calls[0][1]).toMatchObject({
		disableGeoip: true,
		requestTimeout: 2000,
	});
});
it("is disabled when unconfigured and rejects malformed metadata", async () => {
	const { captureServerAnalytics } = await import("./analytics");
	await captureServerAnalytics(
		"user",
		"environment_started",
		{ repositories: 0 },
		{ key: "id", timestamp: new Date() },
	);
	vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
	await captureServerAnalytics(
		"user",
		"pull_request_created",
		{},
		{ key: "id", timestamp: new Date() },
	);
	expect(sdk.captureImmediate).not.toHaveBeenCalled();
});
it("does not propagate ingestion failures", async () => {
	sdk.captureImmediate.mockRejectedValueOnce(new Error("offline"));
	const { captureServerAnalytics } = await import("./analytics");
	await expect(
		captureServerAnalytics(
			"user",
			"pull_request_created",
			{},
			{ key: "id", timestamp: new Date() },
		),
	).resolves.toBeUndefined();
});

it("records per-tool timing and model buckets but strips private payloads", async () => {
	const { captureServerAnalytics } = await import("./analytics");
	await captureServerAnalytics(
		"owner",
		"harness_tool_completed",
		{
			runtime: "api",
			role: "builder",
			tool_name: "read_file",
			error_class: "none",
			category: "read",
			duration_ms: 42,
			outcome: "completed",
			repeated_read: true,
			model_key: "a".repeat(64),
			...{
				input: "PRIVATE_SOURCE",
				output: "PRIVATE_RESULT",
				modelId: "PRIVATE_MODEL",
			},
		},
		{ key: "private-task", timestamp: new Date() },
	);
	const sent = sdk.captureImmediate.mock.calls[0]?.[0];
	expect(sent.properties).toMatchObject({
		duration_ms: 42,
		repeated_read: true,
		tool_name: "read_file",
	});
	expect(JSON.stringify(sent)).not.toContain("PRIVATE_");
});

it("sends sign-up attribution as event properties and $set_once person properties", async () => {
	const { captureServerAnalytics } = await import("./analytics");
	const initial = { initial_ref: "x", initial_utm_source: "twitter" };
	await captureServerAnalytics("user", "account_created", initial, {
		key: "user",
		timestamp: new Date(),
		setOnce: initial,
	});
	expect(sdk.captureImmediate.mock.calls[0][0].properties).toMatchObject({
		...initial,
		$set_once: initial,
	});
	await captureServerAnalytics(
		"user2",
		"account_created",
		{ initial_ref: "<bad>" },
		{ key: "user2", timestamp: new Date() },
	);
	expect(sdk.captureImmediate).toHaveBeenCalledTimes(1);
});
