import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("executes the pinned Rigkit engine under Bun and reuses task outputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-rigkit-test-"));
	try {
		await mkdir(join(root, "rigkit"));
		const module = JSON.stringify(
			resolve("node_modules/@rigkit/engine/src/index.ts"),
		);
		await writeFile(
			join(root, "rigkit/index.ts"),
			`import {workflow} from ${module}; export const setup=workflow('proof').sequence('prepare').task('verified',async()=>({ctx:{verified:true}}));`,
		);
		const script = `import {createDevMachineEngine} from ${module}; const e=await createDevMachineEngine({projectDir:${JSON.stringify(root)}}); const loaded=await e.load(); const input={workflow:loaded.workflows[0].name}; const a=await e.apply(input); const b=await e.apply(input); console.log(JSON.stringify({first:a.context,second:b.context,cached:b.plan.cachedNodeCount}));`;
		const result = await promisify(execFile)(
			process.env.BUN_BINARY || "bun",
			["--no-env-file", "-e", script],
			{ timeout: 30_000, env: { PATH: process.env.PATH } },
		);
		const proof = JSON.parse(result.stdout.trim());
		expect(proof.first.verified).toBe(true);
		expect(proof.second.verified).toBe(true);
		expect(proof.cached).toBeGreaterThan(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 35_000);
