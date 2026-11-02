import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { productionDeploySteps } from "../scripts/production-deploy-steps";

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
