import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	setupFiles,
	type TaskEnvironment,
} from "../scripts/hard-set/environment";
import { readerScratchDirectory } from "../src/domain/subagent-reader";
import { FAKE_READER_UID, hardSetRoute } from "./helpers/hard-set-route";

const task = {
	envImage: "env@sha256:1",
	verifierImage: "verifier@sha256:2",
	compose: { services: { main: {} } },
	sidecars: [],
	artifacts: [{ source: "/app", service: "main", exclude: [] }],
} as unknown as TaskEnvironment;

const app = realpathSync(mkdtempSync(join(tmpdir(), "hard-set-app-")));
const route = hardSetRoute([app]);
afterAll(() => {
	route.dispose();
	rmSync(app, { recursive: true, force: true });
});
const scratch = readerScratchDirectory("e89a5ea5-f995-4d7c-a017-76b553ed27e6");

describe("hard set: read-only subagents' commands run in the task container", () => {
	it("routes a reader's command through its one sudo rule, as its uid with its scratch HOME", () => {
		const run = route.run(route.script("pwd -P; echo home=$HOME"), {
			user: "ytimesy-reader",
			cwd: app,
			home: scratch,
		});
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`${app}\nhome=${scratch}\n`);
		expect(run.sudo[0]?.slice(0, 2)).toEqual(["-n", `${route.dir}/tb-route`]);
		const exec = run.docker.find((args) => args.includes("-w")) ?? [];
		expect(exec.slice(0, 3)).toEqual([
			"exec",
			"-u",
			`${FAKE_READER_UID}:${FAKE_READER_UID}`,
		]);
		expect(exec).toContain(`HOME=${scratch}`);
		expect(exec).toContain(`TMPDIR=${scratch}`);
		// The script is in a fresh root-owned directory, removed afterwards.
		expect(exec.at(-1)).toMatch(/route\/reader\.[A-Za-z0-9]+\/command\.sh'?$/);
		expect(
			execFileSync("ls", ["-A", join(route.dir, "route")], {
				encoding: "utf8",
			}),
		).toBe("");
		// Its process group is signalled as the reader too.
		const stops = run.docker.filter((args) => args.includes("sh"));
		expect(stops.length).toBeGreaterThan(0);
		for (const stop of stops)
			expect(stop.slice(0, 3)).toEqual([
				"exec",
				"-u",
				`${FAKE_READER_UID}:${FAKE_READER_UID}`,
			]);
	});

	it("keeps the builder's route unchanged: no sudo, the container's own user", () => {
		const run = route.run(route.script("pwd -P"), {
			user: "ubuntu",
			cwd: app,
			home: "/home/ubuntu",
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`${app}\n`);
		expect(run.sudo).toEqual([]);
		for (const args of run.docker) expect(args).not.toContain("-u");
	});

	it("never routes a reader as root without the rule, nor with a HOME outside its scratch", () => {
		const outside = route.run(route.script("echo home=$HOME"), {
			user: "ytimesy-reader",
			cwd: app,
			home: "/root",
		});
		expect(outside.stdout).toBe("home=/tmp/ytimesy-agents\n");
		// Called without sudo, the route never takes the reader's path, and a
		// stop request there is refused.
		const direct = spawnSync(
			"/bin/bash",
			[`${route.dir}/tb-route`, "--stop", "1-1"],
			{ encoding: "utf8" },
		);
		expect(direct.status).toBe(2);
	});

	it("installs the reader's sudo rule and proves the reader route during setup", () => {
		const setup = setupFiles(task, "demo")["/tb/setup.sh"];
		execFileSync("bash", ["-n"], { input: setup });
		expect(setup).toContain(
			"'ytimesy-reader ALL=(root) NOPASSWD: /usr/local/bin/tb-route'",
		);
		expect(setup).toContain("'Defaults:ytimesy-reader !use_pty'");
		expect(setup).toContain("visudo -cqf /tb/sudoers-reader");
		expect(setup).toContain('expected="routed:container:$ruid:$WD:read-only"');
		// Briefs name the checkout by ~/<project> inside the container too.
		expect(setup).toContain("chmod o+x /home/ubuntu");
		const files = setupFiles(task, "demo");
		execFileSync("bash", ["-n"], { input: files["/tb/tb-route"] });
		execFileSync("bash", ["-n"], { input: files["/tb/zz-tb-route.sh"] });
		// dash's kill rejects "--": a group kill must not use it.
		expect(files["/tb/tb-route"]).not.toContain("kill -$1 --");
	});
});
