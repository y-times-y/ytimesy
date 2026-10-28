import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { isMainModule } from "../evals/harbor_v2/main-module";

it("treats a module as the started script only by its own file name and URL", () => {
	const url = "file:///opt/repo/evals/harbor_v2/preflight.ts";
	expect(
		isMainModule(url, "preflight", "/opt/repo/evals/harbor_v2/preflight.ts"),
	).toBe(true);
	expect(isMainModule(url, "preflight", undefined)).toBe(false);
	// In a bundle every module shares the bundle's URL.
	const bundle = "file:///home/ubuntu/bridge.mjs";
	expect(isMainModule(bundle, "preflight", "/home/ubuntu/bridge.mjs")).toBe(
		false,
	);
	expect(isMainModule(bundle, "efficiency", "/home/ubuntu/bridge.mjs")).toBe(
		false,
	);
});

const directory = mkdtemp(join(tmpdir(), "harbor-bundle-"));
afterAll(async () => rm(await directory, { recursive: true, force: true }));

// The hosts run one esbuild bundle of the bridge (scripts/tb4-sample/host-setup.sh);
// on 2026-10-27/28 preflight.ts's command line ran inside it and every trial died at start.
it("runs the bundled bridge's own startup, never an imported module's command line", async () => {
	const out = join(await directory, "bridge.mjs");
	execFileSync(
		join(process.cwd(), "node_modules/.bin/esbuild"),
		[
			"evals/harbor_v2/bridge.ts",
			"--bundle",
			"--platform=node",
			"--format=esm",
			"--target=node22",
			`--outfile=${out}`,
			"--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
			"--log-level=error",
		],
		{ stdio: "pipe" },
	);
	const run = spawnSync(process.execPath, [out], {
		encoding: "utf8",
		env: { PATH: process.env.PATH },
		input: "",
		timeout: 60_000,
	});
	const output = `${run.stdout}${run.stderr}`;
	expect(output).not.toContain("--tasks a,b is required");
	expect(output).toContain("YTIMESY_HARBOR_ROUTE must be one of");
}, 120_000);
