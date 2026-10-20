import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	setupFiles,
	type TaskEnvironment,
} from "../../scripts/hard-set/environment";
import { SOURCE_AGENT_SECRETS } from "../../src/domain/project-secret";
import { READER_LINUX_USER } from "../../src/domain/subagent-reader";

/** The reader's uid and gid the fake sudo reports (the VM's useradd --system value). */
export const FAKE_READER_UID = "998";

const TASK = {
	envImage: "env@sha256:1",
	verifierImage: "verifier@sha256:2",
	compose: { services: { main: {} } },
	sidecars: [],
	artifacts: [],
} as unknown as TaskEnvironment;

export type RoutedRun = {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Every `docker` invocation, as its argument list. */
	docker: string[][];
	/** Every `sudo` invocation, as its argument list. */
	sudo: string[][];
};

/**
 * A hard-set VM's command route, run locally: the real login hook and route
 * script from scripts/hard-set/environment.ts with their /tb and
 * /usr/local/bin paths moved into a temporary directory, and shims for what
 * needs root or Docker. `sudo` allows exactly what the setup's sudoers rule
 * allows (the reader may run the route as root, nothing else); `docker`
 * records its arguments and runs the container side locally, in its -w
 * directory with its -e environment.
 */
export function hardSetRoute(mounts: readonly string[]) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "hard-set-route-")));
	const files = setupFiles(TASK, "demo");
	const local = (text: string) =>
		text
			.replaceAll("/usr/local/bin/tb-route", `${dir}/tb-route`)
			.replaceAll("/tb/route-prefix", `${dir}/route-prefix`)
			.replaceAll("/tb/route-mounts", `${dir}/route-mounts`)
			.replaceAll("/tb/route/", `${dir}/route/`);
	const route = local(files["/tb/tb-route"]);
	const hook = local(files["/tb/zz-tb-route.sh"]);
	if (/\/tb\//.test(route + hook))
		throw new Error("The route names a /tb path the emulation does not move.");
	mkdirSync(join(dir, "route"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "route-prefix"), files["/tb/route-prefix"]);
	writeFileSync(
		join(dir, "route-mounts"),
		`${mounts.map((mount) => realpathSync(mount)).join("\n")}\n`,
	);
	writeFileSync(join(dir, "tb-route"), route);
	chmodSync(join(dir, "tb-route"), 0o755);
	writeFileSync(join(dir, "hook.sh"), hook);
	const shims: Record<string, string> = {
		sudo: `printf '%s\\n' "$*" >> ${dir}/sudo.log
if [ "$FAKE_USER" = ${READER_LINUX_USER} ] && [ "$1" = -n ] && [ "$2" = ${dir}/tb-route ]; then
  shift 2
  exec env FAKE_ROOT=1 SUDO_USER=${READER_LINUX_USER} SUDO_UID=${FAKE_READER_UID} SUDO_GID=${FAKE_READER_UID} ${dir}/tb-route "$@"
fi
echo "sudo: a password is required" >&2
exit 1`,
		id: `case "$1" in
  -u) if [ -n "$FAKE_ROOT" ]; then echo 0; else echo 1000; fi ;;
  -un) echo "$FAKE_USER" ;;
  *) exec /usr/bin/id "$@" ;;
esac`,
		setsid: `[ "$1" = --wait ] && shift
exec "$@"`,
		date: `if [ "$1" = +%s%N ]; then printf '%s%09d\\n' "$(/bin/date +%s)" "$((RANDOM * 32768 + RANDOM))"; else exec /bin/date "$@"; fi`,
		docker: `{ printf '%s' docker; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${dir}/docker.log
[ "$1" = exec ] && shift
workdir=/
envs=()
while [ $# -gt 0 ]; do
  case "$1" in
    -u) shift 2 ;;
    -w) workdir=$2; shift 2 ;;
    -e) envs+=("$2"); shift 2 ;;
    -i) shift ;;
    *) break ;;
  esac
done
[ "$1" = tb ] || { echo "unexpected container $1" >&2; exit 125; }
shift
cd "$workdir" || exit 126
exec env -i PATH="$PATH" HOME=/ "\${envs[@]}" "$@"`,
	};
	for (const [name, body] of Object.entries(shims)) {
		writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`);
		chmodSync(join(dir, "bin", name), 0o755);
	}
	const lines = (name: string) => {
		try {
			return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
	return {
		dir,
		/**
		 * One command as the runtime starts it on the VM: `bash -lc <script>`
		 * as `user`, in `cwd`, with `home` as HOME (the login hook is sourced
		 * the way /etc/profile.d would).
		 */
		run(
			script: string,
			options: { user: string; cwd: string; home: string },
		): RoutedRun {
			rmSync(join(dir, "docker.log"), { force: true });
			rmSync(join(dir, "sudo.log"), { force: true });
			const result = spawnSync("/bin/bash", ["-c", script], {
				cwd: options.cwd,
				encoding: "utf8",
				timeout: 20_000,
				// A socket on stdin (Node's "pipe") makes bash skip BASH_ENV.
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: `${dir}/bin:/usr/bin:/bin`,
					BASH_ENV: join(dir, "hook.sh"),
					HOME: options.home,
					FAKE_USER: options.user,
				},
			});
			return {
				exitCode: result.status ?? 1,
				stdout: result.stdout,
				stderr: result.stderr,
				docker: lines("docker.log").map((line) => line.split("\t").slice(1)),
				sudo: lines("sudo.log").map((line) => line.split(" ")),
			};
		},
		/** A command the agent runs, as the runtime wraps it (agent-secrets prefix). */
		script: (command: string) => `${SOURCE_AGENT_SECRETS}\n${command}`,
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * A VM command as the user it runs as: a read-only subagent's commands
 * arrive wrapped in readerCommand (src/domain/subagent-reader.ts).
 */
export function vmCommandUser(sent: string) {
	const reader =
		/^sudo -n -u ytimesy-reader -- env HOME=(\S+) .* bash -c "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"$/s.exec(
			sent,
		);
	return reader
		? {
				user: READER_LINUX_USER,
				home: reader[1] as string,
				command: Buffer.from(reader[2] as string, "base64").toString("utf8"),
			}
		: { user: "ubuntu", home: "/home/ubuntu", command: sent };
}

/**
 * The login-shell script inside a command the runtime sent to the VM: base64
 * layers (the reader wrapper, the command runner's job file, the scoped
 * runner's argument) decoded until the text that starts with the
 * agent-secrets prefix appears, which is what the hard-set hook routes.
 */
export function routedScript(command: string, depth = 0): string | null {
	if (command.startsWith(SOURCE_AGENT_SECRETS)) return command;
	if (depth > 4) return null;
	for (const match of command.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
		const decoded = Buffer.from(match[0], "base64").toString("utf8");
		if (!/^[\s\S]*$/u.test(decoded) || decoded.includes("�")) continue;
		const found = routedScript(decoded, depth + 1);
		if (found) return found;
	}
	return null;
}
