import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { retentionTouchParams } from "#/server/adapters/freestyle/workspace-retention";
import {
	assertProductionBuildAnalytics,
	assertProductionRoutes,
	PRODUCTION_RETENTION_ENROLL_AFTER,
	productionAnalyticsSettings,
	productionRuntimeSettings,
} from "../scripts/production-settings";
import {
	PRODUCTION_TOOLS_IMAGE,
	productionToolsSnapshotId,
} from "../scripts/production-tools-image";
import { PINNED_CLAUDE_AGENT_SDK_VERSION } from "../src/domain/guest-cli-pin";

it("ships the boot-verified SDK image instead of a stale environment override", () => {
	expect(PRODUCTION_TOOLS_IMAGE.claudeAgentSdkVersion).toBe(
		PINNED_CLAUDE_AGENT_SDK_VERSION,
	);
	expect(
		productionRuntimeSettings({ YTIMESY_TOOLS_SNAPSHOT_ID: "sh-stale" })
			.YTIMESY_TOOLS_SNAPSHOT_ID,
	).toBe(PRODUCTION_TOOLS_IMAGE.snapshotId);
	expect(() =>
		productionToolsSnapshotId({
			snapshotId: "sh-stale",
			claudeAgentSdkVersion: "0.0.0",
		}),
	).toThrow("Rebuild and boot-verify");
});

it("deploys production with workspace retention on and an enrollment cutover", () => {
	const settings = productionRuntimeSettings({});
	expect(settings.YTIMESY_ENVIRONMENT).toBe("production");
	expect(settings.YTIMESY_WORKSPACE_RETENTION).toBe("true");
	expect(settings.YTIMESY_INFRASTRUCTURE_ADMISSION).toBe("true");
	expect(settings.YTIMESY_RETENTION_ENROLL_AFTER).toBe(
		PRODUCTION_RETENTION_ENROLL_AFTER,
	);
	expect(
		productionRuntimeSettings({
			YTIMESY_RETENTION_ENROLL_AFTER: "2027-01-01T00:00:00Z",
		}).YTIMESY_RETENTION_ENROLL_AFTER,
	).toBe("2027-01-01T00:00:00Z");
});

it("enrolls production agent VMs created after the cutover, never earlier ones", () => {
	const settings = productionRuntimeSettings({});
	const saved = { ...process.env };
	Object.assign(process.env, settings, {
		YTIMESY_USER_5H_MICRO_USD: "1",
		YTIMESY_USER_WEEKLY_MICRO_USD: "1",
		YTIMESY_FLEET_MONTHLY_MICRO_USD: "1",
		YTIMESY_FLEET_LIFETIME_MICRO_USD: "1",
	});
	try {
		const vm = {
			id: "vm-1",
			slug: "ytimesy-ag-0123456789abcdef",
			resources: { cpu: 1, memory: 1024, storage: 1 },
		};
		const after = retentionTouchParams({
			...vm,
			createdAt: "2026-10-20T00:00:00Z",
		} as never);
		expect(after.slice(3)).toEqual([true, true]);
		const before = retentionTouchParams({
			...vm,
			createdAt: "2026-09-01T00:00:00Z",
		} as never);
		expect(before.slice(3)).toEqual([false, true]);
		// Templates and build VMs are never touched.
		const template = retentionTouchParams({
			...vm,
			slug: "ytimesy-ws-1",
			createdAt: "2026-10-20T00:00:00Z",
		} as never);
		expect(template[4]).toBe(false);
	} finally {
		process.env = saved;
	}
});

it("deploys the PostHog token under the name the server reads", () => {
	expect(
		productionAnalyticsSettings({
			POSTHOG_PROJECT_TOKEN: "phc_server",
			VITE_POSTHOG_PROJECT_TOKEN: "phc_browser",
		}),
	).toEqual({
		POSTHOG_PROJECT_TOKEN: "phc_server",
		POSTHOG_HOST: "https://us.i.posthog.com",
	});
	expect(() =>
		productionAnalyticsSettings({
			POSTHOG_KEY: "phc_old",
			VITE_POSTHOG_PROJECT_TOKEN: "phc_browser",
		}),
	).toThrow(/rename it to POSTHOG_PROJECT_TOKEN/);
	expect(() =>
		productionAnalyticsSettings({ POSTHOG_PROJECT_TOKEN: "phc_server" }),
	).toThrow(/missing VITE_POSTHOG_PROJECT_TOKEN/);
});

it("fails only a production web build that lacks the browser token", () => {
	expect(() =>
		assertProductionBuildAnalytics({ CLOUDFLARE_ENV: "production" }),
	).toThrow(/VITE_POSTHOG_PROJECT_TOKEN/);
	expect(() =>
		assertProductionBuildAnalytics({
			CLOUDFLARE_ENV: "production",
			VITE_POSTHOG_PROJECT_TOKEN: "phc_browser",
		}),
	).not.toThrow();
	expect(() => assertProductionBuildAnalytics({})).not.toThrow();
	expect(() =>
		assertProductionBuildAnalytics({ CLOUDFLARE_ENV: "development" }),
	).not.toThrow();
});

const productionConfig = (extra: string) =>
	`{ "env": { "development": { "routes": [{ "pattern": "dev.example.com" }] },
	  "production": { "name": "x", ${extra} "workers_dev": false } } }`;
const gate = (file: string, extra: string) => () =>
	assertProductionRoutes({
		file,
		text: productionConfig(extra),
		gitProxyUrl: "https://edge.ytimesy.com",
		appUrl: "https://ytimesy.com",
	});

it("lets only the executor route its own Git proxy custom domain in production", () => {
	expect(gate("wrangler.web.jsonc", "")).not.toThrow();
	expect(gate("wrangler.edge-executor.jsonc", "")).not.toThrow();
	expect(
		gate(
			"wrangler.edge-executor.jsonc",
			'"routes": [{ "pattern": "edge.ytimesy.com", "custom_domain": true }],',
		),
	).not.toThrow();
	// The web Worker stays route-less until launch, even on the same domain.
	expect(
		gate(
			"wrangler.web.jsonc",
			'"routes": [{ "pattern": "edge.ytimesy.com", "custom_domain": true }],',
		),
	).toThrow("no routes until launch");
	for (const routes of [
		'"routes": [{ "pattern": "ytimesy.com", "custom_domain": true }],',
		'"routes": [{ "pattern": "edge.ytimesy.com/*", "zone_name": "ytimesy.com" }],',
		'"routes": [{ "pattern": "edge.ytimesy.com" }],',
		'"routes": [{ "pattern": "edge.ytimesy.com", "custom_domain": true }, { "pattern": "other.ytimesy.com", "custom_domain": true }],',
		'"route": "edge.ytimesy.com/*",',
	])
		expect(gate("wrangler.edge-executor.jsonc", routes), routes).toThrow();
	expect(() =>
		assertProductionRoutes({
			file: "wrangler.edge-executor.jsonc",
			text: '{ "env": { "production": { "workers_dev": true } } }',
			gitProxyUrl: "https://edge.ytimesy.com",
			appUrl: "https://ytimesy.com",
		}),
	).toThrow("workers_dev off");
});

it("passes the committed production wrangler configs at go-live, and only then", () => {
	const check = (file: string, goLive: boolean) => () =>
		assertProductionRoutes({
			file,
			text: readFileSync(file, "utf8"),
			gitProxyUrl: "https://edge.ytimesy.com",
			appUrl: "https://ytimesy.com",
			goLive,
		});
	for (const file of ["wrangler.web.jsonc", "wrangler.edge-executor.jsonc"])
		expect(check(file, true)).not.toThrow();
	// The web Worker's only public address is the app host: no deploy without go-live.
	expect(check("wrangler.web.jsonc", false)).toThrow(/no routes until launch/);
});

it("refuses a production deploy without the PR repair webhook secret", () => {
	const script = readFileSync("scripts/deploy-production.ts", "utf8");
	const required = script.slice(
		script.indexOf("const required = ["),
		script.indexOf("] as const;"),
	);
	expect(required).toContain('"GITHUB_PR_REPAIR_WEBHOOK_SECRET"');
});

it("lets the web Worker route only the app host, and only at go-live", () => {
	const web = (extra: string, goLive?: boolean) => () =>
		assertProductionRoutes({
			file: "wrangler.web.jsonc",
			text: productionConfig(extra),
			gitProxyUrl: "https://edge.ytimesy.com",
			appUrl: "https://ytimesy.com",
			goLive,
		});
	const app = `"routes": [{ "pattern": "ytimesy.com", "custom_domain": true }],`;
	expect(web(app)).toThrow(/no routes until launch/);
	expect(web(app, true)).not.toThrow();
	expect(
		web(
			`"routes": [{ "pattern": "www.ytimesy.com", "custom_domain": true }],`,
			true,
		),
	).toThrow(/only route the app host ytimesy.com/);
	expect(
		web(
			`"routes": [{ "pattern": "ytimesy.com/*", "zone_name": "ytimesy.com" }],`,
			true,
		),
	).toThrow(/only route the app host/);
});
