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
	`rule="$(echo "$*" | sed 's/^-w -[CI] //; s/^OUTPUT 1 /OUTPUT /')"
case "$2" in
  -C) grep -qxF -- "$rule" "${dir}/${name}.rules" 2>/dev/null ;;
  -I) echo "$rule" >> "${dir}/${name}.rules" ;;
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
	expect(readFileSync(join(dir, "iptables.rules"), "utf8")).toBe(
		"OUTPUT -d 169.254.169.254 -j REJECT\nOUTPUT -d 169.254.170.2 -j REJECT\n",
	);
	expect(readFileSync(join(dir, "ip6tables.rules"), "utf8")).toBe(
		"OUTPUT -d fd00:ec2::254 -j REJECT\n",
	);
	// No owner match: the rules hold for the builder and anyone else.
	expect(GUEST_METADATA_BLOCK_SCRIPT).not.toContain("--uid-owner");
	rmSync(join(dir, "calls"));
	expect(run().status).toBe(0);
	expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain(" -I ");
});

it("fails closed without a table or when a rule does not hold", () => {
	table("iptables");
	const missing = run();
	expect(missing.status).not.toBe(0);
	expect(missing.stderr).toContain("ip6tables unavailable");
	table("ip6tables", 'case "$2" in -C) exit 1;; esac');
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
