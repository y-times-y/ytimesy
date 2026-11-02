import { describe, expect, it } from "vitest";
import {
	claudePlanUsageBars,
	claudePlanUsageFromHeaders,
	claudePlanUsageFromJson,
} from "./claude-plan-usage";

const now = 1_800_000_000_000;
const headers = (values: Record<string, string>) => new Headers(values);

describe("Claude plan usage headers", () => {
	it("reads status, reset and the 5h and 7d windows", () => {
		expect(
			claudePlanUsageFromHeaders(
				headers({
					"anthropic-ratelimit-unified-status": "allowed_warning",
					"anthropic-ratelimit-unified-reset": "1800003600",
					"anthropic-ratelimit-unified-5h-utilization": "0.876",
					"anthropic-ratelimit-unified-5h-reset": "1800003600",
					"anthropic-ratelimit-unified-7d-utilization": "0.25",
					"anthropic-ratelimit-unified-7d-reset": "1800400000",
					"anthropic-ratelimit-unified-representative-claim": "five_hour",
				}),
				now,
			),
		).toEqual({
			status: "allowed_warning",
			resetsAt: 1_800_003_600_000,
			windows: [
				{ id: "5h", usedPercent: 88, resetsAt: 1_800_003_600_000 },
				{ id: "7d", usedPercent: 25, resetsAt: 1_800_400_000_000 },
			],
			readAt: now,
		});
	});

	it("clamps odd values, drops unreadable windows and resets", () => {
		const usage = claudePlanUsageFromHeaders(
			headers({
				"anthropic-ratelimit-unified-5h-utilization": "1.7",
				"anthropic-ratelimit-unified-5h-reset": "soon",
				"anthropic-ratelimit-unified-7d-utilization": "",
			}),
			now,
		);
		expect(usage?.windows).toEqual([
			{ id: "5h", usedPercent: 100, resetsAt: null },
		]);
		expect(usage?.status).toBeNull();
	});

	it("is null on a response without unified headers", () => {
		expect(
			claudePlanUsageFromHeaders(
				headers({ "anthropic-ratelimit-requests-limit": "50" }),
				now,
			),
		).toBeNull();
	});

	it("round-trips through stored JSON and rejects malformed rows", () => {
		const usage = claudePlanUsageFromHeaders(
			headers({
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.5",
			}),
			now,
		);
		expect(claudePlanUsageFromJson(JSON.parse(JSON.stringify(usage)))).toEqual(
			usage,
		);
		expect(claudePlanUsageFromJson(null)).toBeNull();
		expect(claudePlanUsageFromJson({ windows: [] })).toBeNull();
		expect(
			claudePlanUsageFromJson({
				readAt: now,
				windows: [
					{ id: "1d", usedPercent: 5 },
					{ id: "7d", usedPercent: 500 },
				],
			})?.windows,
		).toEqual([]);
	});
});

describe("Claude plan usage bars", () => {
	const usage = {
		status: "allowed",
		resetsAt: now + 3_600_000,
		readAt: now,
		windows: [
			{ id: "5h" as const, usedPercent: 40, resetsAt: now + 3_600_000 },
			{ id: "7d" as const, usedPercent: 10, resetsAt: now + 400_000_000 },
		],
	};

	it("labels the windows 5h and Week", () => {
		expect(claudePlanUsageBars(usage, now)).toEqual([
			{ id: "5h", label: "5h", usedPercent: 40, resetsAt: now + 3_600_000 },
			{ id: "7d", label: "Week", usedPercent: 10, resetsAt: now + 400_000_000 },
		]);
	});

	it("starts a window over once its reset has passed", () => {
		expect(claudePlanUsageBars(usage, now + 4_000_000)[0]).toMatchObject({
			usedPercent: 0,
			resetsAt: null,
		});
	});

	it("shows the spent window full while a rejection holds", () => {
		const rejected = { ...usage, status: "rejected" };
		expect(claudePlanUsageBars(rejected, now)[0]?.usedPercent).toBe(100);
		expect(claudePlanUsageBars(rejected, now)[1]?.usedPercent).toBe(10);
	});

	it("is empty with no reading", () => {
		expect(claudePlanUsageBars(null, now)).toEqual([]);
	});
});
