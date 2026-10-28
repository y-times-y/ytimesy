import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	DESKTOP_CREDENTIAL_DROP_SETUP,
	DESKTOP_PRIVATE_DIRECTORY,
	DESKTOP_PRIVATE_READY,
	DESKTOP_WAIT_UNTIL,
	probeWorkspaceDesktop,
	START_WORKSPACE_DESKTOP,
} from "./start-desktop";

/** The viewer-proxy block of the start script, run against stub commands in a scratch dir. */
function viewerBlock(dir: string) {
	const start = START_WORKSPACE_DESKTOP.indexOf("DESK_AUTH_DROP=");
	const end = START_WORKSPACE_DESKTOP.indexOf("python3 - <<'PY'", start);
	return `HOME=${dir}\nDESK_PRIVATE=${dir}\nVNC_SOCKET=${dir}/rfb.sock\n${DESKTOP_WAIT_UNTIL}\n${START_WORKSPACE_DESKTOP.slice(
		start,
		end,
	).replaceAll(DESKTOP_PRIVATE_DIRECTORY, dir)}`;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "desk-viewer-"));
	const stub = (name: string, body: string) => {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	};
	stub("ss", `cat "${dir}/ss.out" 2>/dev/null || true`);
	stub("pkill", `echo "pkill $*" >> "${dir}/calls"`);
	stub("websockify", `echo "websockify $*" >> "${dir}/calls"`);
	stub("sleep", "true");
	stub("sha256sum", `shasum -a 256 "$1"`);
	// pgrep -f answers from pgrep.out: the proxy already running, if any.
	stub("pgrep", `grep -q -- "$2" "${dir}/pgrep.out" 2>/dev/null`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(
	listening = "",
	running = listening ? `websockify --unix-target=${dir}/rfb.sock` : "",
) {
	writeFileSync(join(dir, "ss.out"), listening);
	writeFileSync(join(dir, "pgrep.out"), running);
	execFileSync("/bin/sh", ["-eu", "-c", `${viewerBlock(dir)}\nwait`], {
		env: { PATH: `${dir}:/usr/bin:/bin` },
	});
	try {
		return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
	} catch {
		return [];
	}
}

it("listens publicly only behind the credential, and records which one", () => {
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:secret");
	expect(run()).toEqual([
		"pkill -x websockify",
		`websockify --auth-plugin ytimesy_desk_auth.FileBasicHTTPAuth --auth-source ${dir}/viewer.credential --unix-target=${dir}/rfb.sock 0.0.0.0:6080`,
	]);
	// The credential is read from its file, never passed in argv.
	expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain("secret");
	expect(readFileSync(join(dir, "viewer.applied"), "utf8")).toBe(
		createHash("sha256").update("ytimesy:secret").digest("hex"),
	);
});

it("keeps a proxy that already runs with the current credential", () => {
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:secret");
	writeFileSync(
		join(dir, "viewer.applied"),
		createHash("sha256").update("ytimesy:secret").digest("hex"),
	);
	expect(run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n")).toEqual([]);
});

it("replaces a proxy started with an older credential", () => {
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:new");
	writeFileSync(join(dir, "viewer.applied"), "old");
	expect(run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n")[0]).toBe(
		"pkill -x websockify",
	);
});

it("without a credential, stops an open public proxy and listens on loopback only", () => {
	expect(run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n")).toEqual([
		"pkill -x websockify",
	]);
	rmSync(join(dir, "calls"));
	expect(run("")).toEqual([
		`websockify --unix-target=${dir}/rfb.sock 127.0.0.1:6080`,
	]);
	rmSync(join(dir, "calls"));
	expect(run("LISTEN 0 100 127.0.0.1:6080 0.0.0.0:*\n")).toEqual([]);
});

it("probes for the credential it expects and refuses anything but a digest", () => {
	const digest = "a".repeat(64);
	expect(probeWorkspaceDesktop(digest)).toContain(`= "${digest}" ]`);
	expect(() => probeWorkspaceDesktop("$(reboot)")).toThrow();
});

it("restarts a proxy left from the TCP viewer even when its credential is current", () => {
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:secret");
	writeFileSync(
		join(dir, "viewer.applied"),
		createHash("sha256").update("ytimesy:secret").digest("hex"),
	);
	expect(
		run(
			"LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n",
			"websockify 0.0.0.0:6080 127.0.0.1:5900",
		)[0],
	).toBe("pkill -x websockify");
});

it("loads the viewer credential from its file in the auth plugin", () => {
	execFileSync("/bin/sh", ["-eu", "-c", viewerBlock(dir)], {
		env: { PATH: `${dir}:/usr/bin:/bin` },
	});
	// A stand-in for websockify's BasicHTTPAuth, which compares user:password to src.
	const fake = join(dir, "fake", "websockify");
	execFileSync("mkdir", ["-p", fake]);
	writeFileSync(join(fake, "__init__.py"), "");
	writeFileSync(
		join(fake, "auth_plugins.py"),
		"class BasicHTTPAuth:\n    def __init__(self, src=None):\n        self.src = src\n",
	);
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:secret\n");
	const src = execFileSync(
		"python3",
		[
			"-c",
			"import sys, ytimesy_desk_auth as a; print(a.FileBasicHTTPAuth(sys.argv[1]).src)",
			join(dir, "viewer.auth"),
		],
		{
			env: {
				PYTHONPATH: `${join(dir, ".ytimesy", "desk-auth")}:${join(dir, "fake")}`,
			},
			encoding: "utf8",
		},
	);
	expect(src).toBe("ytimesy:secret\n");
});

it("moves the dropped credential into the proxy's own 0600 file and removes the drop", () => {
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:secret", { mode: 0o644 });
	run();
	expect(existsSync(join(dir, "viewer.auth"))).toBe(false);
	expect(readFileSync(join(dir, "viewer.credential"), "utf8")).toBe(
		"ytimesy:secret",
	);
	expect(statSync(join(dir, "viewer.credential")).mode & 0o777).toBe(0o600);
});

/** The drop setup against a scratch path instead of the VM's fixed one. */
function dropSetup(path: string) {
	return spawnSync(
		"/bin/sh",
		[
			"-c",
			DESKTOP_CREDENTIAL_DROP_SETUP.replaceAll(DESKTOP_PRIVATE_DIRECTORY, path),
		],
		{ encoding: "utf8" },
	);
}

it("creates the credential's directory 0700 as this user and clears an earlier drop", () => {
	const path = join(dir, "private");
	const created = dropSetup(path);
	expect(created.status).toBe(0);
	expect(created.stdout).toContain(DESKTOP_PRIVATE_READY);
	expect(statSync(path).mode & 0o777).toBe(0o700);
	writeFileSync(join(path, "viewer.auth"), "stale");
	expect(dropSetup(path).status).toBe(0);
	expect(existsSync(join(path, "viewer.auth"))).toBe(false);
	// One this user made too open is tightened, not trusted as is.
	chmodSync(path, 0o777);
	expect(dropSetup(path).status).toBe(0);
	expect(statSync(path).mode & 0o777).toBe(0o700);
});

it("refuses a credential directory another user pre-created or linked in /tmp", () => {
	// A link to a directory this user owns is still refused.
	const target = join(dir, "elsewhere");
	mkdirSync(target);
	const link = join(dir, "linked");
	symlinkSync(target, link);
	const linked = dropSetup(link);
	expect(linked.status).not.toBe(0);
	expect(linked.stdout).not.toContain(DESKTOP_PRIVATE_READY);
	expect(linked.stderr).toContain("refusing the desktop credential");
	// A file in its place.
	writeFileSync(join(dir, "file"), "");
	expect(dropSetup(join(dir, "file")).status).not.toBe(0);
	// A directory another user owns (root's, as a stand-in for a reader's).
	if (process.getuid?.() !== 0) {
		const foreign = dropSetup("/usr");
		expect(foreign.status).not.toBe(0);
		expect(foreign.stdout).not.toContain(DESKTOP_PRIVATE_READY);
	}
});

it("never matches its own command line when it looks for or stops processes", () => {
	// Run as `bash -c <script>` the script's command line holds every pattern
	// it greps for; a self-matching pkill -f killed the start (exit 143).
	const patterns = [
		...START_WORKSPACE_DESKTOP.matchAll(
			/p(?:grep|kill)(?: -TERM)? -f (?:-- )?(['"])(.+?)\1/g,
		),
	].map((match) => match[2].replaceAll("$VNC_SOCKET", "/x/rfb.sock"));
	expect(patterns.length).toBeGreaterThanOrEqual(2);
	for (const pattern of patterns)
		expect(new RegExp(pattern).test(START_WORKSPACE_DESKTOP), pattern).toBe(
			false,
		);
});

/** The x11vnc block of the start script, run against stub commands. */
function vncBlock() {
	const start = START_WORKSPACE_DESKTOP.indexOf('VNC_DIR="');
	const end = START_WORKSPACE_DESKTOP.indexOf("# The viewer port", start);
	return `HOME=${dir}\nDESK_PRIVATE=${dir}\nXAUTH=${dir}/Xauthority\n${DESKTOP_WAIT_UNTIL}\n${START_WORKSPACE_DESKTOP.slice(
		start,
		end,
	).replaceAll(DESKTOP_PRIVATE_DIRECTORY, dir)}`;
}

function runVnc(listening: string, x11vncRunning = false) {
	writeFileSync(join(dir, "ss.out"), listening);
	writeFileSync(join(dir, "pgrep.out"), x11vncRunning ? "x11vnc" : "");
	writeFileSync(
		join(dir, "pgrep"),
		`#!/bin/sh\nif [ "$1" = -x ]; then grep -qx -- "$2" "${dir}/pgrep.out" 2>/dev/null; else exit 1; fi\n`,
	);
	chmodSync(join(dir, "pgrep"), 0o755);
	writeFileSync(
		join(dir, "x11vnc"),
		`#!/bin/sh\necho "x11vnc $*" >> "${dir}/calls"\n`,
	);
	chmodSync(join(dir, "x11vnc"), 0o755);
	const result = spawnSync("/bin/sh", ["-eu", "-c", `${vncBlock()}\nwait`], {
		env: { PATH: `${dir}:/usr/bin:/bin` },
		encoding: "utf8",
	});
	let calls: string[] = [];
	try {
		calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
	} catch {}
	return { ...result, calls };
}

it("serves VNC on its Unix socket only, behind the dropped password", () => {
	writeFileSync(join(dir, "vnc.password"), "pass1234\n");
	const started = runVnc("");
	expect(started.status).toBe(0);
	const x11vnc = started.calls.find((call) => call.startsWith("x11vnc"));
	expect(x11vnc).toContain(`-passwdfile ${dir}/vnc.passwd`);
	expect(x11vnc).toContain("-rfbport 0 -rfbportv6 -1 -noipv6");
	expect(x11vnc).not.toContain("-nopw");
	expect(existsSync(join(dir, "vnc.password"))).toBe(false);
	expect(readFileSync(join(dir, "vnc.passwd"), "utf8")).toBe("pass1234\n");
	expect(statSync(join(dir, "vnc.passwd")).mode & 0o777).toBe(0o600);
});

it("restarts an x11vnc found on TCP and refuses the desktop if it stays there", () => {
	writeFileSync(join(dir, "vnc.password"), "pass1234\n");
	// The live failure: x11vnc on [::]:5900 with no password.
	const exposed = runVnc("LISTEN 0 32 [::]:5900 [::]:*\n", true);
	expect(exposed.calls).toContain("pkill -x x11vnc");
	expect(exposed.status).not.toBe(0);
	expect(exposed.stderr).toContain("x11vnc listened on TCP");
});
