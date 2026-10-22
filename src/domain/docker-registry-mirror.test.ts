import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	DOCKER_HUB_MIRROR,
	dockerRegistryMirrorScript,
} from "./docker-registry-mirror";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function daemonJson() {
	const directory = mkdtempSync(join(tmpdir(), "daemon-json-"));
	directories.push(directory);
	return join(directory, "docker", "daemon.json");
}
const run = (path: string) =>
	execFileSync(
		"bash",
		["-euo", "pipefail", "-c", dockerRegistryMirrorScript(path, false)],
		{
			stdio: "pipe",
			env: { ...process.env, PATH: "/usr/bin:/bin" },
		},
	);

it("writes the mirror when there is no daemon.json", () => {
	const path = daemonJson();
	run(path);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		"registry-mirrors": [DOCKER_HUB_MIRROR],
	});
});

it("keeps the user's settings and mirrors, adding ours once", () => {
	const path = daemonJson();
	run(path);
	writeFileSync(
		path,
		JSON.stringify({
			"default-address-pools": [{ base: "10.200.0.0/14", size: 24 }],
			"registry-mirrors": ["https://mirror.example.test"],
		}),
	);
	run(path);
	run(path);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		"default-address-pools": [{ base: "10.200.0.0/14", size: 24 }],
		"registry-mirrors": ["https://mirror.example.test", DOCKER_HUB_MIRROR],
	});
});

it("leaves a daemon.json it cannot read as an object alone", () => {
	const path = daemonJson();
	run(path);
	writeFileSync(path, "[1, 2]");
	expect(() => run(path)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("[1, 2]");
});
