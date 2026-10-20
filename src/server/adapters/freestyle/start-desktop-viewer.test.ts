import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	probeWorkspaceDesktop,
	START_WORKSPACE_DESKTOP,
} from "./start-desktop";

/** The viewer-proxy block of the start script, run against stub commands in a scratch dir. */
function viewerBlock(dir: string) {
	const start = START_WORKSPACE_DESKTOP.indexOf("DESK_AUTH_FILE=");
	const end = START_WORKSPACE_DESKTOP.indexOf("python3 - <<'PY'", start);
	return `HOME=${dir}\nVNC_SOCKET=${dir}/rfb.sock\n${START_WORKSPACE_DESKTOP.slice(
		start,
		end,
	).replaceAll("/tmp/ytimesy-desk", `${dir}/ytimesy-desk`)}`;
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
	running = listening ? "websockify --unix-target" : "",
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
	writeFileSync(join(dir, "ytimesy-desk-viewer.auth"), "ytimesy:secret");
	expect(run()).toEqual([
		"pkill -f websockify.*:6080",
		`websockify --auth-plugin ytimesy_desk_auth.FileBasicHTTPAuth --auth-source ${dir}/ytimesy-desk-viewer.auth --unix-target=${dir}/rfb.sock 0.0.0.0:6080`,
	]);
	// The credential is read from its file, never passed in argv.
	expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain("secret");
	expect(readFileSync(join(dir, "ytimesy-desk-auth.applied"), "utf8")).toBe(
		createHash("sha256").update("ytimesy:secret").digest("hex"),
	);
});

it("keeps a proxy that already runs with the current credential", () => {
	writeFileSync(join(dir, "ytimesy-desk-viewer.auth"), "ytimesy:secret");
	writeFileSync(
		join(dir, "ytimesy-desk-auth.applied"),
		createHash("sha256").update("ytimesy:secret").digest("hex"),
	);
	expect(run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n")).toEqual([]);
});

it("replaces a proxy started with an older credential", () => {
	writeFileSync(join(dir, "ytimesy-desk-viewer.auth"), "ytimesy:new");
	writeFileSync(join(dir, "ytimesy-desk-auth.applied"), "old");
	expect(run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n")[0]).toBe(
		"pkill -f websockify.*:6080",
	);
});

it("without a credential, stops an open public proxy and listens on loopback only", () => {
	expect(run("LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n")).toEqual([
		"pkill -f websockify.*:6080",
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
	expect(probeWorkspaceDesktop(digest)).toContain(`== "${digest}"`);
	expect(() => probeWorkspaceDesktop("$(reboot)")).toThrow();
});

it("restarts a proxy left from the TCP viewer even when its credential is current", () => {
	writeFileSync(join(dir, "ytimesy-desk-viewer.auth"), "ytimesy:secret");
	writeFileSync(
		join(dir, "ytimesy-desk-auth.applied"),
		createHash("sha256").update("ytimesy:secret").digest("hex"),
	);
	expect(
		run(
			"LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*\n",
			"websockify 0.0.0.0:6080 127.0.0.1:5900",
		)[0],
	).toBe("pkill -f websockify.*:6080");
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
	writeFileSync(join(dir, "ytimesy-desk-viewer.auth"), "ytimesy:secret\n");
	const src = execFileSync(
		"python3",
		[
			"-c",
			"import sys, ytimesy_desk_auth as a; print(a.FileBasicHTTPAuth(sys.argv[1]).src)",
			join(dir, "ytimesy-desk-viewer.auth"),
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
