import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	READER_LINUX_USER,
	READER_NETWORK_ISOLATION_CHECK,
	READER_NETWORK_NAMESPACE,
	READER_USER_SETUP_SCRIPT,
	readerCheckoutAccessScript,
	readerCommand,
	readerMayWrite,
	readerPreparationScript,
	readerScratchDirectory,
} from "./subagent-reader";

/**
 * Stand-ins for sudo (drops -n and -u user --) and unshare (records its
 * arguments, drops --net --) that run the rest, so the wrapper's shell
 * shape runs on any machine. `unshare` overrides its body.
 */
function stubs(dir: string, bodies: { unshare?: string }) {
	const write = (name: string, body: string) => {
		writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	};
	write(
		"sudo",
		'[ "$1" = -n ] && shift; if [ "$1" = -u ]; then shift 3; fi; exec "$@"',
	);
	write(
		"unshare",
		bodies.unshare ??
			'echo "unshare $(printf "%s " "$@" | cut -c1-110 | sed "s/ *$//")" >> "$CALLS"; shift 2; exec "$@"',
	);
}

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
			"find '/home/ubuntu/repo' -type f \\( -name '.env*' -o -name .git-credentials -o -name .netrc \\) -exec chmod o-rwx {} +",
		);
		expect(script).toContain("sudo -n chmod 1777 /tmp/ytimesy-sessions");
	});

	/**
	 * A checkout written under umask 077 (0600 files, 0700 directories), with
	 * a dotenv file and a link to a private file outside it. `tools` names
	 * the commands on PATH besides the stand-ins; sudo always fails, as for a
	 * builder without root.
	 */
	function umask077Checkout() {
		const root = mkdtempSync(join(tmpdir(), "reader-checkout-"));
		const repo = join(root, "repo");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".git", "objects", "ab"), { recursive: true });
		mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
		mkdirSync(bin);
		writeFileSync(join(repo, "package.json"), "{}");
		writeFileSync(join(repo, ".agents", "skills", "SKILL.md"), "x");
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(repo, ".env"), "SECRET=1");
		writeFileSync(join(root, "id_rsa"), "key");
		symlinkSync(join(root, "id_rsa"), join(repo, "leak"));
		for (const file of [
			"package.json",
			".agents/skills/SKILL.md",
			".git/HEAD",
			".env",
			"../id_rsa",
		])
			chmodSync(join(repo, file), 0o600);
		for (const dir of [".git/objects/ab", ".git", ".agents/skills", ".agents"])
			chmodSync(join(repo, dir), 0o700);
		chmodSync(repo, 0o700);
		writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "sudo"), 0o755);
		const mode = (path: string) => statSync(join(repo, path)).mode & 0o777;
		const run = () =>
			spawnSync("/bin/bash", ["-c", readerCheckoutAccessScript(repo)], {
				env: { PATH: bin },
				encoding: "utf8",
			});
		const tool = (name: string, body?: string) => {
			if (body) {
				writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
				chmodSync(join(bin, name), 0o755);
				return;
			}
			const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
				encoding: "utf8",
			}).stdout.trim();
			symlinkSync(found, join(bin, name));
		};
		return { root, repo, mode, run, tool };
	}

	it("is part of preparation whenever there is a checkout", () => {
		expect(
			readerPreparationScript({ sessionId: "c", checkout: "/home/ubuntu/r" }),
		).toContain(readerCheckoutAccessScript("/home/ubuntu/r"));
		expect(readerPreparationScript({ sessionId: "c" })).not.toContain(
			"ytimesy_reader_grant",
		);
	});

	it("grants the reader user alone read access to a umask-077 checkout by ACL, inherited by new files", () => {
		const { root, repo, run, tool } = umask077Checkout();
		try {
			tool("find");
			tool("chmod");
			// A stand-in setfacl records each call and the paths it got.
			tool("setfacl", `echo "$*" >> "${root}/calls"`);
			expect(run().status).toBe(0);
			const calls = readFileSync(join(root, "calls"), "utf8")
				.trim()
				.split("\n")
				.map((line) => line.replaceAll(repo, "R"));
			const granted = (path: string, how: string) =>
				calls.some((c) => c.startsWith(how) && c.split(" ").includes(path));
			const dirs = ["R", "R/.git", "R/.git/objects/ab", "R/.agents/skills"];
			for (const dir of dirs)
				expect(
					granted(dir, "-m u:ytimesy-reader:rX,d:u:ytimesy-reader:rX "),
					dir,
				).toBe(true);
			for (const file of [
				"R/package.json",
				"R/.git/HEAD",
				"R/.agents/skills/SKILL.md",
			])
				expect(granted(file, "-m u:ytimesy-reader:rX "), file).toBe(true);
			// Never write access, never through the link, and the dotenv file
			// loses what the walk granted it.
			expect(calls.join("\n")).not.toMatch(/rw|R\/leak/);
			expect(granted("R/.env", "-x u:ytimesy-reader ")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to read-only modes without setfacl, keeping dotenv files and link targets private", () => {
		const { root, repo, mode, run, tool } = umask077Checkout();
		try {
			tool("find");
			tool("chmod");
			expect(run().status).toBe(0);
			expect(mode("")).toBe(0o705);
			expect(mode(".git/objects/ab")).toBe(0o705);
			expect(mode("package.json")).toBe(0o604);
			expect(mode(".git/HEAD")).toBe(0o604);
			expect(mode(".agents/skills/SKILL.md")).toBe(0o604);
			expect(mode(".env")).toBe(0o600);
			expect(statSync(join(root, "id_rsa")).mode & 0o777).toBe(0o600);
			expect(statSync(join(repo, "leak")).isFile()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a reader where network namespaces are unavailable", () => {
		const script = readerPreparationScript({ sessionId: "child-1" });
		expect(script).toContain(READER_NETWORK_ISOLATION_CHECK);
		const dir = mkdtempSync(join(tmpdir(), "reader-netns-"));
		try {
			stubs(dir, { unshare: "exit 1" });
			const refused = spawnSync(
				"/bin/bash",
				["-c", READER_NETWORK_ISOLATION_CHECK],
				{
					env: { PATH: `${dir}:/usr/bin:/bin` },
					encoding: "utf8",
				},
			);
			expect(refused.status).not.toBe(0);
			expect(refused.stderr).toContain("network namespaces are unavailable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs a command as the reader inside its own network namespace, the command intact", () => {
		const command = `echo "it's $((1+1))" | cat`;
		const wrapped = readerCommand("child-1", command);
		// The namespace is created as root first; only inside it does the
		// command switch to the reader.
		expect(
			wrapped.startsWith(
				`${READER_NETWORK_NAMESPACE} sudo -n -u ytimesy-reader -- env HOME=/tmp/ytimesy-agents/child-1 `,
			),
		).toBe(true);
		// The payload decodes back to the exact command (no quoting layers).
		const encoded = /printf %s (\S+) \| base64 -d/.exec(wrapped)?.[1] ?? "";
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(command);
		const dir = mkdtempSync(join(tmpdir(), "reader-netns-"));
		try {
			const run = (text: string) =>
				spawnSync("/bin/bash", ["-c", text], {
					env: { PATH: `${dir}:/usr/bin:/bin`, CALLS: join(dir, "calls") },
					encoding: "utf8",
				});
			// With stand-ins for sudo and unshare the same shell shape runs locally.
			stubs(dir, {});
			const ran = run(wrapped);
			expect(ran.stdout.trim()).toBe("it's 2");
			expect(readFileSync(join(dir, "calls"), "utf8").split("\n")[0]).toMatch(
				/^unshare --net -- sh -c ip link set lo up .* ytimesy-reader-net sudo -n -u ytimesy-reader/,
			);
			// Git accepts the builder's checkout although another user owns it.
			expect(
				run(
					readerCommand("child-1", "git config --get-all safe.directory"),
				).stdout.trim(),
			).toBe("*");
			// No namespace, no command.
			stubs(dir, { unshare: "exit 1" });
			const refused = run(readerCommand("child-1", "echo ran"));
			expect(refused.status).not.toBe(0);
			expect(refused.stdout).not.toContain("ran");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The live failure: the reader reached the builder's 127.0.0.1 and ::1
	// listeners. Needs Linux and root to create a namespace.
	it.runIf(process.platform === "linux" && process.getuid?.() === 0)(
		"leaves the reader no route to the builder's loopback listeners",
		async () => {
			const servers = await Promise.all(
				["127.0.0.1", "::1"].map(
					(host) =>
						new Promise<import("node:net").Server>((resolve) => {
							const server = createServer(() => {});
							server.listen(0, host, () => resolve(server));
						}),
				),
			);
			try {
				for (const server of servers) {
					const { address, port } = server.address() as AddressInfo;
					const probe = address.includes(":") ? `[${address}]` : address;
					const result = spawnSync(
						"/bin/bash",
						[
							"-c",
							`unshare --net -- sh -c 'ip link set lo up >/dev/null 2>&1; exec "$@"' x bash -c 'exec 3<>/dev/tcp/${address}/${port}' && echo connected`,
						],
						{ encoding: "utf8" },
					);
					expect(result.stdout, probe).not.toContain("connected");
				}
			} finally {
				for (const server of servers) server.close();
			}
		},
	);

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
