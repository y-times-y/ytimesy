import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	READER_ISOLATION_FAILED,
	READER_ISOLATION_FAILED_EXIT,
	READER_LINUX_USER,
	READER_LOOPBACK_BLOCK_SCRIPT,
	READER_USER_SETUP_SCRIPT,
	readerCommand,
	readerLoopbackGuardCommand,
	readerMayWrite,
	readerPreparationScript,
	readerScratchDirectory,
} from "./subagent-reader";

describe("reader Linux user", () => {
	it("is baked into the tools snapshot recipe and its --verify report", () => {
		const recipe = readFileSync("scripts/build-tools-snapshot.ts", "utf8");
		expect(recipe).toMatch(
			/name: "reader user",\s*script: READER_USER_SETUP_SCRIPT,/,
		);
		expect(recipe).toContain('"id ytimesy-reader"');
		expect(READER_USER_SETUP_SCRIPT).toContain(
			`id -u ${READER_LINUX_USER} >/dev/null 2>&1 || useradd --system`,
		);
	});

	it("prepares a shared VM without granting the reader the home, the secrets or dotenv files", () => {
		const script = readerPreparationScript({
			sessionId: "child-1",
			checkout: "/home/ubuntu/repo",
		});
		expect(script).toContain(
			`sudo -n install -d -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0700 /tmp/ytimesy-agents/child-1`,
		);
		expect(script).toContain('chmod o-rw,o+x "$HOME"');
		expect(script).toContain("chmod 0700 /tmp/ytimesy-secrets");
		expect(script).toContain(
			"find '/home/ubuntu/repo' -maxdepth 4 -name node_modules -prune -o -name '.env*' -type f -exec chmod o-rwx {} +",
		);
		expect(script).toContain("sudo -n chmod 1777 /tmp/ytimesy-sessions");
	});

	it("refuses the reader loopback TCP (DevTools, debug adapters, the viewer) as root, idempotently", () => {
		const script = readerPreparationScript({ sessionId: "child-1" });
		expect(script).toContain(
			`sudo -n bash -c "$(printf %s ${Buffer.from(READER_LOOPBACK_BLOCK_SCRIPT).toString("base64")} | base64 -d)"`,
		);
		expect(READER_LOOPBACK_BLOCK_SCRIPT).toContain(
			`OUTPUT -o lo -p tcp -m owner --uid-owner ${READER_LINUX_USER} -j REJECT`,
		);
		expect(READER_LOOPBACK_BLOCK_SCRIPT).toContain('"$table" -w -C $rule');
		expect(READER_LOOPBACK_BLOCK_SCRIPT).toContain("ip6tables");
	});

	it("fails closed: no iptables, or a rule that does not verify, refuses the reader", () => {
		const dir = mkdtempSync(join(tmpdir(), "reader-iptables-"));
		try {
			const run = () =>
				spawnSync("/bin/bash", ["-c", READER_LOOPBACK_BLOCK_SCRIPT], {
					env: { PATH: dir },
					encoding: "utf8",
				});
			// Neither table on PATH.
			const missing = run();
			expect(missing.status).not.toBe(0);
			expect(missing.stderr).toContain("iptables unavailable");
			// A table that accepts -I but never holds the rule (no owner match).
			const table = (name: string, body: string) => {
				writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
				chmodSync(join(dir, name), 0o755);
			};
			const forgetful = 'case "$2" in -C) exit 1;; *) exit 0;; esac';
			table("iptables", forgetful);
			table("ip6tables", forgetful);
			const unverified = run();
			expect(unverified.status).not.toBe(0);
			expect(unverified.stderr).toContain("refused the reader loopback rule");
			// Only iptables works: ip6tables still refuses the reader.
			const holding = `case "$2" in -C) test -f "${dir}/\${0##*/}.rule";; -I) : > "${dir}/\${0##*/}.rule";; esac`;
			table("iptables", holding);
			expect(run().status).not.toBe(0);
			table("ip6tables", holding);
			expect(run().status).toBe(0);
			// The guard that precedes every reader command refuses distinctly.
			rmSync(join(dir, "ip6tables"));
			const guarded = spawnSync(
				"/bin/bash",
				[
					"-c",
					`${readerLoopbackGuardCommand().replace("sudo -n ", "")} && echo ran`,
				],
				{ env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" },
			);
			expect(guarded.status).toBe(READER_ISOLATION_FAILED_EXIT);
			expect(guarded.stderr).toContain(READER_ISOLATION_FAILED);
			expect(guarded.stdout).not.toContain("ran");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs a command as the reader with its scratch as HOME and the command intact", () => {
		const command = `echo "it's $((1+1))" | cat`;
		const wrapped = readerCommand("child-1", command);
		expect(wrapped).toMatch(
			/^sudo -n -u ytimesy-reader -- env HOME=\/tmp\/ytimesy-agents\/child-1 /,
		);
		// The payload decodes back to the exact command (no quoting layers).
		const encoded = /printf %s (\S+) \| base64 -d/.exec(wrapped)?.[1] ?? "";
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(command);
		// Without sudo the same shell shape runs locally.
		const local = wrapped.replace(/^sudo -n -u ytimesy-reader -- /, "");
		expect(
			execFileSync("bash", ["-c", local], { encoding: "utf8" }).trim(),
		).toBe("it's 2");
		// Git accepts the builder's checkout although another user owns it.
		const git = readerCommand(
			"child-1",
			"git config --get-all safe.directory",
		).replace(/^sudo -n -u ytimesy-reader -- /, "");
		expect(execFileSync("bash", ["-c", git], { encoding: "utf8" }).trim()).toBe(
			"*",
		);
	});

	it("lets the runtime write only to the reader's scratch, runtime root and payload files", () => {
		const root = "/tmp/ytimesy-sessions/child-1";
		const scratch = readerScratchDirectory("child-1");
		expect(readerMayWrite(`${scratch}/notes.md`, "child-1", root)).toBe(true);
		expect(readerMayWrite(`${root}/x.json`, "child-1", root)).toBe(true);
		expect(
			readerMayWrite(
				"/tmp/ytimesy-lean-helpers-0f8fad5b-d9cb-469f-a165-70867728950e.json",
				"child-1",
				root,
			),
		).toBe(true);
		// The attempt loop's per-attempt directory (created for the checker).
		expect(
			readerMayWrite(
				"/tmp/ytimesy-attempts/turn-1/2/tests/run.sh",
				"child-1",
				root,
			),
		).toBe(true);
		for (const path of [
			"/tmp/ytimesy-attempts/turn-1/2",
			"/tmp/ytimesy-attempts/turn-1/x/run.sh",
			"/tmp/ytimesy-attempts/turn-1/2/../../../etc/x",
			"/home/ubuntu/repo/src/a.ts",
			"/tmp/ytimesy-secrets/agent.env",
			"/tmp/ytimesy-project-cwd",
			`${scratch}/../child-2/x`,
			"/tmp/ytimesy-agents/child-2/x",
		])
			expect(readerMayWrite(path, "child-1", root)).toBe(false);
	});
});
