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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DESKTOP_CREDENTIAL_DROP_SETUP,
	DESKTOP_PRIVATE_DIRECTORY,
	DESKTOP_PRIVATE_READY,
	DESKTOP_THROWAWAY_CREDENTIALS,
	DESKTOP_WAIT_UNTIL,
	probeWorkspaceDesktop,
	START_WORKSPACE_DESKTOP,
} from "./start-desktop";

/** The viewer-proxy block of the start script, run against stub commands in a scratch dir. */
function viewerBlock(dir: string) {
	const start = START_WORKSPACE_DESKTOP.indexOf("DESK_AUTH_DROP=");
	const end = START_WORKSPACE_DESKTOP.indexOf("# A desktop started", start);
	// The proxy starts early; its wait and applied digest come at the end.
	const finish = START_WORKSPACE_DESKTOP.indexOf("# The proxy started above");
	const done = START_WORKSPACE_DESKTOP.indexOf(
		"printf 'YTIMESY_DESKTOP",
		finish,
	);
	return `HOME=${dir}\nDESK_PRIVATE=${dir}\nVNC_SOCKET=${dir}/rfb.sock\nDESK_PROXY_STARTED=0\n${DESKTOP_WAIT_UNTIL}\n${`${START_WORKSPACE_DESKTOP.slice(start, end)}${START_WORKSPACE_DESKTOP.slice(finish, done)}`.replaceAll(DESKTOP_PRIVATE_DIRECTORY, dir)}`;
}

let dir: string;
/** The proxy as the start script launches it: it rereads its credential file. */
const rereadingProxy = () =>
	`websockify --auth-plugin ytimesy_desk_auth.LiveFileBasicHTTPAuth --auth-source ${dir}/viewer.credential --unix-target=${dir}/rfb.sock 0.0.0.0:6080`;
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
	expect(run()).toEqual(["pkill -x websockify", rereadingProxy()]);
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
	expect(
		run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n", rereadingProxy()),
	).toEqual([]);
});

it("gives a running proxy a new credential in place, without a restart", () => {
	// A chat copied from a template that already ran its desktop.
	writeFileSync(join(dir, "viewer.credential"), "ytimesy:template");
	writeFileSync(join(dir, "viewer.applied"), "old");
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:new");
	expect(
		run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n", rereadingProxy()),
	).toEqual([]);
	expect(readFileSync(join(dir, "viewer.credential"), "utf8")).toBe(
		"ytimesy:new",
	);
	expect(readFileSync(join(dir, "viewer.applied"), "utf8")).toBe(
		createHash("sha256").update("ytimesy:new").digest("hex"),
	);
});

it("replaces a proxy that read its credential only once at start", () => {
	writeFileSync(join(dir, "viewer.auth"), "ytimesy:new");
	writeFileSync(join(dir, "viewer.applied"), "old");
	expect(
		run(
			"LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n",
			`websockify --auth-plugin ytimesy_desk_auth.FileBasicHTTPAuth --auth-source ${dir}/viewer.credential --unix-target=${dir}/rfb.sock 0.0.0.0:6080`,
		),
	).toEqual(["pkill -x websockify", rereadingProxy()]);
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

it("checks each connection against the credential file as it is then", () => {
	execFileSync("/bin/sh", ["-eu", "-c", viewerBlock(dir)], {
		env: { PATH: `${dir}:/usr/bin:/bin` },
	});
	// A stand-in for websockify's BasicHTTPAuth (it keeps src; the plugin checks).
	const fake = join(dir, "fake", "websockify");
	execFileSync("mkdir", ["-p", fake]);
	writeFileSync(join(fake, "__init__.py"), "");
	writeFileSync(
		join(fake, "auth_plugins.py"),
		"class BasicHTTPAuth:\n    def __init__(self, src=None):\n        self.src = src\n",
	);
	const file = join(dir, "credential");
	const check = (user: string, password: string) =>
		execFileSync(
			"python3",
			[
				"-c",
				"import sys, ytimesy_desk_auth as a; p = a.LiveFileBasicHTTPAuth(sys.argv[1]); print(p.validate_creds(sys.argv[2], sys.argv[3]), p.src)",
				file,
				user,
				password,
			],
			{
				env: {
					PYTHONPATH: `${join(dir, ".ytimesy", "desk-auth")}:${join(dir, "fake")}`,
				},
				encoding: "utf8",
			},
		).trim();
	// No file yet (or an empty one): nobody gets in.
	expect(check("ytimesy", "")).toBe("False None");
	writeFileSync(file, "");
	expect(check("ytimesy", "")).toBe("False None");
	writeFileSync(file, "ytimesy:secret\n");
	expect(check("ytimesy", "secret")).toBe("True None");
	expect(check("ytimesy", "wrong")).toBe("False None");
	// A replaced file applies to the next connection; the old one stops working.
	writeFileSync(file, "ytimesy:rotated");
	expect(check("ytimesy", "rotated")).toBe("True None");
	expect(check("ytimesy", "secret")).toBe("False None");
});

it("a template's throwaway credentials are random, private and match no real one", () => {
	const path = join(dir, "private");
	const once = () => {
		const result = spawnSync(
			"/bin/sh",
			[
				"-c",
				DESKTOP_THROWAWAY_CREDENTIALS.replaceAll(
					DESKTOP_PRIVATE_DIRECTORY,
					path,
				),
			],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		return {
			viewer: readFileSync(join(path, "viewer.auth"), "utf8"),
			vnc: readFileSync(join(path, "vnc.password"), "utf8"),
		};
	};
	const first = once();
	expect(first.viewer).toMatch(/^ytimesy:[0-9a-f]{40}$/);
	expect(first.vnc).toMatch(/^[0-9a-f]{8}$/);
	expect(statSync(join(path, "viewer.auth")).mode & 0o777).toBe(0o600);
	expect(statSync(join(path, "vnc.password")).mode & 0o777).toBe(0o600);
	const second = once();
	expect(second.viewer).not.toBe(first.viewer);
	expect(second.vnc).not.toBe(first.vnc);
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

/** The VNC block of the start script, run against stub commands. */
function vncBlock(tiger: boolean) {
	const start = START_WORKSPACE_DESKTOP.indexOf("VNC_PASS_DROP=");
	const end = START_WORKSPACE_DESKTOP.indexOf(
		"# The proxy started above",
		start,
	);
	return `HOME=${dir}\nDESK_PRIVATE=${dir}\nXAUTH=${dir}/Xauthority\nVNC_DIR="\${HOME}/.ytimesy/vnc"\nVNC_SOCKET="$VNC_DIR/rfb.sock"\nVNC_TIGER=${dir}/${tiger ? "X0tigervnc" : "absent"}\n${DESKTOP_WAIT_UNTIL}\n${START_WORKSPACE_DESKTOP.slice(
		start,
		end,
	).replaceAll(DESKTOP_PRIVATE_DIRECTORY, dir)}`;
}

const VIEWER_CONNECTED = () =>
	`u_str ESTAB 0 0 ${dir}/.ytimesy/vnc/rfb.sock 18834 * 17812\n`;

/**
 * Runs the VNC block. `running` is the process table: names (for pgrep -x)
 * and command lines (for pgrep -f); pkill -x removes what it matches.
 */
function runVnc(
	listening: string,
	running: readonly string[] = [],
	tiger = true,
) {
	writeFileSync(join(dir, "ss.out"), listening);
	writeFileSync(join(dir, "pgrep.out"), running.map((l) => `${l}\n`).join(""));
	writeFileSync(join(dir, "calls"), "");
	const stub = (name: string, body: string) => {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	};
	stub(
		"pgrep",
		`if [ "$1" = -x ]; then grep -qxE -- "$2" "${dir}/pgrep.out" 2>/dev/null; else grep -q -- "$2" "${dir}/pgrep.out" 2>/dev/null; fi`,
	);
	stub(
		"pkill",
		`echo "pkill $*" >> "${dir}/calls"\ngrep -vE -- "^($2)( |$)" "${dir}/pgrep.out" > "${dir}/pgrep.left" || true\nmv "${dir}/pgrep.left" "${dir}/pgrep.out"`,
	);
	stub("x11vnc", `echo "x11vnc $*" >> "${dir}/calls"`);
	stub("X0tigervnc", `echo "X0tigervnc $*" >> "${dir}/calls"`);
	stub("vncpasswd", `[ "$1" = -f ] || exit 2\nprintf 'obf:'\ncat`);
	const result = spawnSync(
		"/bin/sh",
		["-eu", "-c", `${vncBlock(tiger)}\nwait`],
		{ env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" },
	);
	const calls = readFileSync(join(dir, "calls"), "utf8")
		.split("\n")
		.filter(Boolean);
	return { ...result, calls };
}

it("serves TigerVNC on its Unix socket only, behind the dropped password", () => {
	writeFileSync(join(dir, "vnc.password"), "pass1234");
	const started = runVnc("");
	expect(started.status).toBe(0);
	expect(started.calls).toHaveLength(1);
	const tiger = started.calls[0];
	// The binary itself: the Perl wrappers copy the password file at start.
	expect(tiger).toMatch(/^X0tigervnc -display :0 /);
	expect(tiger).toContain(
		`-rfbport -1 -rfbunixpath ${dir}/.ytimesy/vnc/rfb.sock -rfbunixmode 0600`,
	);
	expect(tiger).toContain(
		`-SecurityTypes VncAuth -PasswordFile ${dir}/vnc.obf `,
	);
	expect(tiger).not.toMatch(/None|-localhost|-interface/);
	expect(existsSync(join(dir, "vnc.password"))).toBe(false);
	expect(readFileSync(join(dir, "vnc.passwd"), "utf8")).toBe("pass1234");
	expect(readFileSync(join(dir, "vnc.obf"), "utf8")).toBe("obf:pass1234");
	for (const file of ["vnc.passwd", "vnc.obf"])
		expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
});

it("gives a running TigerVNC a new password in place, without a restart", () => {
	writeFileSync(join(dir, "vnc.password"), "template");
	runVnc("");
	writeFileSync(join(dir, "vnc.password"), "chatpass");
	const rotated = runVnc("", ["X0tigervnc"]);
	expect(rotated.status).toBe(0);
	expect(rotated.calls).toEqual([]);
	expect(readFileSync(join(dir, "vnc.obf"), "utf8")).toBe("obf:chatpass");
});

it("stops a VNC server found on TCP and refuses the desktop if it stays there", () => {
	writeFileSync(join(dir, "vnc.password"), "pass1234");
	const exposed = runVnc("LISTEN 0 32 [::]:5900 [::]:*\n", ["X0tigervnc"]);
	expect(exposed.calls).toContain("pkill -x X0tigervnc");
	expect(exposed.status).not.toBe(0);
	expect(exposed.stderr).toContain("a VNC server listened on TCP");
	// An x11vnc there is stopped even under a connected viewer.
	const old = runVnc(`LISTEN 0 32 [::]:5900 [::]:*\n${VIEWER_CONNECTED()}`, [
		"x11vnc",
		`x11vnc -display :0 -passwdfile read:${dir}/vnc.passwd -unixsock x -sb 0`,
	]);
	expect(old.calls).toContain("pkill -x x11vnc");
	expect(old.status).not.toBe(0);
});

it("hands an older x11vnc over to TigerVNC, but never under a connected viewer", () => {
	const x11vnc = [
		"x11vnc",
		`x11vnc -display :0 -passwdfile read:${dir}/vnc.passwd -unixsock x -sb 0`,
	];
	writeFileSync(join(dir, "vnc.password"), "chatpass");
	const viewed = runVnc(VIEWER_CONNECTED(), x11vnc);
	expect(viewed.status).toBe(0);
	expect(viewed.calls).toEqual([]);
	// It keeps the password current meanwhile: it rereads the plain file.
	expect(readFileSync(join(dir, "vnc.passwd"), "utf8")).toBe("chatpass");
	const idle = runVnc("", x11vnc);
	expect(idle.status).toBe(0);
	expect(idle.calls[0]).toBe("pkill -x x11vnc");
	expect(idle.calls[1]).toMatch(/^X0tigervnc /);
	// One that never rereads its password goes at once.
	const stale = runVnc(VIEWER_CONNECTED(), [
		"x11vnc",
		`x11vnc -display :0 -passwdfile ${dir}/vnc.passwd -unixsock x`,
	]);
	expect(stale.calls[0]).toBe("pkill -x x11vnc");
});

describe("an image without TigerVNC keeps x11vnc", () => {
	it("serves it on the Unix socket only, rereading the dropped password", () => {
		writeFileSync(join(dir, "vnc.password"), "pass1234");
		const started = runVnc("", [], false);
		expect(started.status).toBe(0);
		expect(started.calls).toHaveLength(1);
		const x11vnc = started.calls[0];
		expect(x11vnc).toContain(`-passwdfile read:${dir}/vnc.passwd `);
		expect(x11vnc).toContain("-rfbport 0 -rfbportv6 -1 -noipv6");
		expect(x11vnc).not.toContain("-nopw");
		// No 1.5 s naps after an idle minute: a template copy's first frame waited for one.
		expect(x11vnc).toMatch(/ -sb 0$/);
		expect(existsSync(join(dir, "vnc.obf"))).toBe(false);
	});

	it("keeps one that rereads its password and only replaces the file", () => {
		writeFileSync(join(dir, "vnc.passwd"), "template");
		writeFileSync(join(dir, "vnc.password"), "chatpass");
		const kept = runVnc(
			"",
			[
				"x11vnc",
				`x11vnc -display :0 -passwdfile read:${dir}/vnc.passwd -unixsock x -sb 0`,
			],
			false,
		);
		expect(kept.status).toBe(0);
		expect(kept.calls).toEqual([]);
		expect(readFileSync(join(dir, "vnc.passwd"), "utf8")).toBe("chatpass");
	});

	it("restarts one that naps when idle, but never under a connected viewer", () => {
		const napping = [
			"x11vnc",
			`x11vnc -display :0 -passwdfile read:${dir}/vnc.passwd -unixsock x`,
		];
		expect(runVnc("", napping, false).calls[0]).toBe("pkill -x x11vnc");
		const viewed = runVnc(VIEWER_CONNECTED(), napping, false);
		expect(viewed.status).toBe(0);
		expect(viewed.calls).toEqual([]);
	});

	it("restarts one that read its password only at start", () => {
		const restarted = runVnc(
			"",
			[
				"x11vnc",
				`x11vnc -display :0 -passwdfile ${dir}/vnc.passwd -unixsock x`,
			],
			false,
		);
		expect(restarted.calls[0]).toBe("pkill -x x11vnc");
	});
});

it("waits on conditions, never on fixed sleeps", () => {
	// Fixed one- and two-second sleeps made most of a desktop restart.
	expect(START_WORKSPACE_DESKTOP).not.toMatch(/^\s*sleep [0-9]+\s*$/m);
});
