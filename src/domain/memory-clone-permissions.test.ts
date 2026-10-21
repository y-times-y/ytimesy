import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { memoryCloneScript } from "./memory-repo";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "memory-clone-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Runs the clone against a remote that does not answer: it stops after storing the token. */
function clone() {
	return spawnSync(
		"/bin/sh",
		[
			"-c",
			memoryCloneScript({
				remote: `file://${home}/no-such-remote.git`,
				token: "art_secret_token",
			}),
		],
		{
			env: { HOME: home, PATH: "/usr/bin:/bin:/usr/local/bin" },
			encoding: "utf8",
		},
	);
}
const mode = (path: string) => statSync(path).mode & 0o777;

it("keeps the token-bearing clone private to the builder: 0700 directories, 0600 config", () => {
	const result = clone();
	expect(result.status).toBe(4);
	const config = join(home, "memory", ".git", "config");
	expect(readFileSync(config, "utf8")).toContain("art_secret_token");
	expect(mode(join(home, "memory"))).toBe(0o700);
	expect(mode(join(home, "memory", ".git"))).toBe(0o700);
	expect(mode(config)).toBe(0o600);
}, 30_000);

it("tightens a clone an earlier version left readable before the new token goes in", () => {
	mkdirSync(join(home, "memory"));
	spawnSync("git", ["init", "-q", "-b", "main", join(home, "memory")]);
	chmodSync(join(home, "memory"), 0o755);
	chmodSync(join(home, "memory", ".git"), 0o755);
	chmodSync(join(home, "memory", ".git", "config"), 0o644);
	expect(clone().status).toBe(4);
	expect(mode(join(home, "memory"))).toBe(0o700);
	expect(mode(join(home, "memory", ".git", "config"))).toBe(0o600);
}, 30_000);
