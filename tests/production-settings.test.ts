import { expect, it } from "vitest";
import { retentionTouchParams } from "#/server/adapters/freestyle/workspace-retention";
import {
	PRODUCTION_RETENTION_ENROLL_AFTER,
	productionRuntimeSettings,
} from "../scripts/production-settings";

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
		YTIMESY_USER_MONTHLY_MICRO_USD: "1",
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
