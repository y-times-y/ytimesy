import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import {
	GUEST_METADATA_BLOCK_SCRIPT,
	guestMetadataBlockCommand,
} from "#/domain/guest-network-guard";
import { blockGuestMetadata } from "./api-turn-workspace";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "metadata-guard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A table that keeps its rules in a file and logs every call. */
function table(name: string, body?: string) {
	writeFileSync(
		join(dir, name),
		`#!/bin/sh
echo "${name} $*" >> "${dir}/calls"
${
	body ??
	`rule="$(echo "$*" | sed 's/^-w -[CI] //; s/^\\([A-Z-]*\\) 1 /\\1 /')"
case "$2" in
  -C) grep -qxF -- "$rule" "${dir}/${name}.rules" 2>/dev/null ;;
  -I) echo "$rule" >> "${dir}/${name}.rules" ;;
  -N) touch "${dir}/${name}.$3" ;;
  -n) test "$3" != -L || test -e "${dir}/${name}.$4" ;;
esac`
}
`,
	);
	chmodSync(join(dir, name), 0o755);
}
const run = () =>
	spawnSync("/bin/sh", ["-c", GUEST_METADATA_BLOCK_SCRIPT], {
		env: { PATH: `${dir}:/usr/bin:/bin` },
		encoding: "utf8",
	});

it("refuses cloud metadata for every user, verified, and only checks once in place", () => {
	table("iptables");
	table("ip6tables");
	expect(run().status).toBe(0);
	// OUTPUT for the VM's own users, DOCKER-USER (reached from FORWARD) for
	// task containers.
	expect(readFileSync(join(dir, "iptables.rules"), "utf8")).toBe(
		[
			"FORWARD -j DOCKER-USER",
			"OUTPUT -d 169.254.169.254 -j REJECT",
			"DOCKER-USER -d 169.254.169.254 -j REJECT",
			"OUTPUT -d 169.254.170.2 -j REJECT",
			"DOCKER-USER -d 169.254.170.2 -j REJECT",
			"",
		].join("\n"),
	);
	expect(readFileSync(join(dir, "ip6tables.rules"), "utf8")).toBe(
		[
			"FORWARD -j DOCKER-USER",
			"OUTPUT -d fd00:ec2::254 -j REJECT",
			"DOCKER-USER -d fd00:ec2::254 -j REJECT",
			"",
		].join("\n"),
	);
	expect(readFileSync(join(dir, "calls"), "utf8")).toContain(
		"iptables -w -N DOCKER-USER",
	);
	expect(readFileSync(join(dir, "calls"), "utf8")).toContain(
		"ip6tables -w -N DOCKER-USER",
	);
	// No owner match: the rules hold for the builder and anyone else.
	expect(GUEST_METADATA_BLOCK_SCRIPT).not.toContain("--uid-owner");
	rmSync(join(dir, "calls"));
	expect(run().status).toBe(0);
	const again = readFileSync(join(dir, "calls"), "utf8");
	expect(again).not.toContain(" -I ");
	expect(again).not.toContain(" -N ");
});

it("keeps rules Docker already routes to, without a second FORWARD jump", () => {
	table("iptables");
	table("ip6tables");
	for (const name of ["iptables", "ip6tables"]) {
		writeFileSync(join(dir, `${name}.DOCKER-USER`), "");
		writeFileSync(join(dir, `${name}.rules`), "FORWARD -j DOCKER-USER\n");
	}
	expect(run().status).toBe(0);
	const calls = readFileSync(join(dir, "calls"), "utf8");
	expect(calls).not.toContain(" -N ");
	expect(calls).not.toContain("-I FORWARD");
	expect(calls).toContain(
		"iptables -w -I DOCKER-USER 1 -d 169.254.169.254 -j REJECT",
	);
});

it("fails closed when DOCKER-USER cannot be created or a container rule does not hold", () => {
	table("iptables", 'case "$2" in -N) exit 1;; -n) exit 1;; esac');
	table("ip6tables");
	const noChain = run();
	expect(noChain.status).not.toBe(0);
	expect(noChain.stderr).toContain("could not create DOCKER-USER");
	table(
		"iptables",
		`case "$2" in -N) touch "${dir}/ok";; -n) test -e "${dir}/ok";; -C) case "$*" in *"DOCKER-USER -d"*) exit 1;; esac;; esac`,
	);
	const unverified = run();
	expect(unverified.status).not.toBe(0);
	expect(unverified.stderr).toContain("in DOCKER-USER");
});

it("fails closed without a table or when a rule does not hold", () => {
	table("iptables");
	const missing = run();
	expect(missing.status).not.toBe(0);
	expect(missing.stderr).toContain("ip6tables unavailable");
	table("ip6tables", 'case "$*" in *" -C OUTPUT "*) exit 1;; esac');
	const unverified = run();
	expect(unverified.status).not.toBe(0);
	expect(unverified.stderr).toContain("refused the metadata rule");
});

it("runs as root, and a machine that cannot block metadata runs no turn", async () => {
	expect(guestMetadataBlockCommand()).toMatch(/^sudo -n bash -c /);
	const exec = vi.fn(async () => ({
		exitCode: 1,
		stdout: "",
		stderr: "ytimesy: iptables unavailable; cloud metadata cannot be blocked",
	}));
	await expect(blockGuestMetadata({ exec }, "vm" as never)).rejects.toThrow(
		"Cloud metadata could not be blocked",
	);
});
