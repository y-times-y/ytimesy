import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	productionDeploySteps,
	rollbackDecision,
	rollbackStep,
	servingVersions,
} from "../scripts/production-deploy-steps";

it("deploys each Worker's code and secrets as one version, edge first", () => {
	const steps = productionDeploySteps({
		edgeConfig: [
			"--config",
			"wrangler.edge-executor.jsonc",
			"--env",
			"production",
		],
		webConfig: ["--config", "dist/server/wrangler.json"],
		edgeSecretsFile: "/tmp/x/edge.json",
		webSecretsFile: "/tmp/x/web.json",
	});
	expect(steps).toEqual([
		[
			"deploy",
			"--secrets-file",
			"/tmp/x/edge.json",
			"--config",
			"wrangler.edge-executor.jsonc",
			"--env",
			"production",
		],
		[
			"deploy",
			"--secrets-file",
			"/tmp/x/web.json",
			"--config",
			"dist/server/wrangler.json",
		],
	]);
	// No separate secret upload: that was a second version, and a restart.
	expect(steps.flat()).not.toContain("secret");
});

it("the production deploy script no longer uploads secrets as their own version", () => {
	const script = readFileSync("scripts/deploy-production.ts", "utf8");
	expect(script).not.toMatch(/\["secret",\s*"bulk"\]/);
	expect(script).toContain("productionDeploySteps(");
	expect(script).toContain("IN_FLIGHT_WORK_NOTE");
});

it("rolls a Worker back to the versions it served before, traffic split included", () => {
	const previous = servingVersions(
		JSON.stringify({
			id: "d1",
			versions: [
				{ version_id: "1c5a2f3e-0b1d-4a6e-9f00-2b7c8d9e0a11", percentage: 90 },
				{ version_id: "7e9b0c1d-2f3a-4b5c-8d6e-0f1a2b3c4d55", percentage: 10 },
			],
		}),
	);
	expect(
		rollbackStep(["--config", "dist/server/wrangler.json"], previous),
	).toEqual([
		"versions",
		"deploy",
		"1c5a2f3e-0b1d-4a6e-9f00-2b7c8d9e0a11@90%",
		"7e9b0c1d-2f3a-4b5c-8d6e-0f1a2b3c4d55@10%",
		"--yes",
		"--message",
		"Rolled back by deploy-production: the post-deploy smoke check failed.",
		"--config",
		"dist/server/wrangler.json",
	]);
	// Before a Worker's first deploy, or on output wrangler did not give as JSON.
	expect(servingVersions("")).toEqual([]);
	expect(servingVersions("{}")).toEqual([]);
	expect(
		servingVersions(
			JSON.stringify({ versions: [{ version_id: "--yes", percentage: 100 }] }),
		),
	).toEqual([]);
});

it("defers Durable Object code updates for the length of a chat step", async () => {
	const { unstable_readConfig } = await import("wrangler");
	for (const env of [undefined, "production"]) {
		const config = unstable_readConfig({
			config: "wrangler.edge-executor.jsonc",
			env,
		});
		expect(config.durable_objects.code_update_strategy).toEqual({
			mode: "deferred",
			max_delay: 900,
		});
	}
});

const v = (id: string, percentage = 100) => ({ versionId: id, percentage });

it("rolls a Worker back only while it still serves the version this deploy made (2026-11-26: two threads deployed together, a failed smoke check tried to undo the other's newer deploy)", () => {
	const ours = [v("aaaaaaaa-1")];
	const before = [v("bbbbbbbb-0")];
	expect(
		rollbackDecision({ deployed: ours, previous: before, current: ours }),
	).toBe("roll-back");
	expect(
		rollbackDecision({
			deployed: ours,
			previous: before,
			current: [v("cccccccc-2")],
		}),
	).toBe("superseded");
	expect(
		rollbackDecision({ deployed: ours, previous: before, current: before }),
	).toBe("already-previous");
	expect(
		rollbackDecision({ deployed: [], previous: before, current: ours }),
	).toBe("superseded");
	expect(
		rollbackDecision({ deployed: ours, previous: [], current: ours }),
	).toBe("no-previous");
});
