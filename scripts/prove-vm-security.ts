// Live security proof of a development workspace VM, set up the way the
// product does: a throwaway eval user, a chat VM from the project's prepared
// environment, the shared desktop and its keyed viewer route, a private
// preview, a read-only (reader) agent user, the Git proxy and the memory
// clone. Prints PASS/FAIL per check, never a secret. No model runs.
//
//   VM_SECURITY_PROOF=1 node --env-file=.env --import tsx scripts/prove-vm-security.ts

//
// Development only: refuses any database but the development project.
// Everything it creates (users, chats, VMs, snapshots, routes, the forward
// auth config, the memory repo, Git proxy claims, a local quick tunnel) is
// removed in `finally`, and a cleanup summary is printed.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { Freestyle } from "freestyle";
import WebSocket from "ws";
import {
	issueGitProxyGrant,
	proxyGithubGit,
} from "../src/domain/github-git-proxy";
import {
	GUEST_METADATA_DESTINATIONS,
	guestMetadataBlockCommand,
} from "../src/domain/guest-network-guard";
import { WorkspaceId } from "../src/domain/ids";
import {
	memoryCloneScript,
	SCRUB_MEMORY_CREDENTIAL,
} from "../src/domain/memory-repo";
import { AGENT_SECRETS_DIRECTORY } from "../src/domain/project-secret";
import { READER_LINUX_USER } from "../src/domain/subagent-reader";
import {
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { closeDatabase, database } from "../src/server/adapters/database";
import { forkRunningVm } from "../src/server/adapters/freestyle/fork-vm";
import { productCreateVmFields } from "../src/server/adapters/freestyle/product-vm";
import {
	DESKTOP_PRIVATE_DIRECTORY,
	DESKTOP_XAUTHORITY,
	START_WORKSPACE_DESKTOP,
} from "../src/server/adapters/freestyle/start-desktop";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import {
	gitProxyConfiguration,
	pushProxiedRepository,
} from "../src/server/adapters/github/git-proxy-transfer";
import {
	type ArtifactsNamespace,
	memoryRepo,
	registerMemoryRepos,
} from "../src/server/adapters/memory-repos";
import { claimGitProxyGrant } from "../src/server/edge/github-git-authorization";
import { readerWorkspaceMachines } from "../src/server/services/reader-workspace-machines";
import {
	authorizePreviewRequest,
	EDGE_AUTHORIZER_HEADER,
	edgeAuthorizerKey,
	edgeAuthorizerUrl,
	PREVIEW_COOKIE,
	previewLoginUrl,
} from "../src/server/services/vm-edge-auth";
import {
	desktopEdgeHostname,
	desktopViewerAuthorization,
	desktopViewerCredential,
	previewHostname,
	sharedPreviewHostname,
} from "../src/server/services/vm-edge-keys";
import {
	ensureDesktopProcesses,
	publishDesktopViewer,
	withdrawDesktopViewer,
} from "../src/server/services/workspace-desktop";
import { attachTerminalUpgrade } from "../src/server/terminal-ws";
import { DEVELOPMENT_EDGE_ORIGIN } from "./development-config";
import { createEvalUser, MEMORY_NAMESPACE } from "./smoke/eval-user";
import { RFB_SECURITY_PY, rfbRequiresPassword } from "./vnc-rfb-probe";

const run = promisify(execFile);
const DEV_REF = "exampledevprojectref";
const PROD_REF = "exampleprojectref";
const PREVIEW_PORT = 8000;
const VM_CAP_SECONDS = 3600;
const MEMORY_TOKEN_TTL_SECONDS = 150;

if (process.env.VM_SECURITY_PROOF !== "1")
	throw new Error("Enable VM_SECURITY_PROOF=1.");
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== DEV_REF ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(DEV_REF) ||
	`${process.env.DATABASE_URL}${process.env.APP_URL}`.includes(PROD_REF) ||
	`${process.env.APP_URL}${process.env.BETTER_AUTH_URL}`.includes("ytimesy.com")
)
	throw new Error("Refusing to run: not the development environment.");
// Like the other local proofs: VMs here carry their own runtime cap, so the
// local process skips usage admission (it still applies on the edge).
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("FREESTYLE_API_KEY is required.");

// ---------------------------------------------------------------------------
// Results and cleanup bookkeeping (never holds a secret in printable fields).

type Result = {
	item: string;
	check: string;
	pass: boolean | null;
	evidence: string;
};
const results: Result[] = [];
function record(
	item: string,
	check: string,
	pass: boolean | null,
	evidence: string,
) {
	results.push({ item, check, pass, evidence });
	const mark = pass === null ? "SKIP" : pass ? "PASS" : "FAIL";
	console.log(`[${mark}] ${item} ${check}: ${evidence}`);
}
const safeError = (error: unknown) =>
	(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
		.replace(/(Bearer|Basic)\s+\S+/gi, "$1 <redacted>")
		.replace(/https?:\/\/[^\s"']*@/g, "https://<redacted>@")
		.slice(0, 240);

const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const vms = new Set<string>();
const snapshots = new Set<string>();
const forwardAuthIds = new Set<string>();
const claimedNonces = new Set<string>();
const cleanup: string[] = [];
const leftovers: string[] = [];
const localServers: Server[] = [];
let tunnel: ChildProcess | null = null;
const scratch = await mkdtemp(join(tmpdir(), "ytimesy-vmsec-"));

// ---------------------------------------------------------------------------
// Small helpers.

const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function exec(vm: string, command: string, ms = 60_000) {
	return machines.exec(WorkspaceId(vm), command, ms);
}

async function execOk(vm: string, command: string, ms = 60_000) {
	const result = await exec(vm, command, ms);
	if (result.exitCode !== 0)
		throw new Error(
			`VM command failed (${result.exitCode}): ${(result.stderr || result.stdout).slice(-300)}`,
		);
	return result.stdout;
}

type Probe = {
	status: number | null;
	body: string;
	setCookie: string | null;
	error?: string;
};
async function httpProbe(url: string, init: RequestInit = {}): Promise<Probe> {
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
			...init,
		});
		const body = await response.text().catch(() => "");
		return {
			status: response.status,
			body,
			setCookie: response.headers.get("set-cookie"),
		};
	} catch (error) {
		return {
			status: null,
			body: "",
			setCookie: null,
			error: safeError(error).slice(0, 80),
		};
	}
}
const shown = (probe: Probe) =>
	probe.status === null ? `no response (${probe.error})` : String(probe.status);

/** Polls until `ready` holds (route propagation and certificates take a moment). */
async function pollProbe(
	url: string,
	init: RequestInit,
	ready: (probe: Probe) => boolean,
	ms = 150_000,
) {
	const deadline = Date.now() + ms;
	let last: Probe = { status: null, body: "", setCookie: null };
	while (Date.now() < deadline) {
		last = await httpProbe(url, init);
		if (ready(last)) return last;
		await delay(4000);
	}
	return last;
}

/** WebSocket handshake outcome: 101 when it opened, else the HTTP status or an error. */
function wsProbe(
	url: string,
	options: {
		headers?: Record<string, string>;
		origin?: string;
		firstMessage?: boolean;
	},
) {
	return new Promise<{ status: number | null; detail: string }>((resolve) => {
		const socket = new WebSocket(url, ["binary"], {
			headers: options.headers,
			origin: options.origin,
			handshakeTimeout: 20_000,
		});
		const done = (status: number | null, detail: string) => {
			socket.removeAllListeners();
			socket.on("error", () => {});
			try {
				socket.terminate();
			} catch {}
			resolve({ status, detail });
		};
		socket.on("open", () => {
			if (!options.firstMessage) return done(101, "opened");
			const timer = setTimeout(() => done(101, "opened, no data"), 8000);
			socket.once("message", (data: Buffer) => {
				clearTimeout(timer);
				done(
					101,
					`opened, first bytes ${JSON.stringify(data.subarray(0, 11).toString("latin1"))}`,
				);
			});
			socket.once("close", () => {
				clearTimeout(timer);
				done(101, "opened, then closed without data");
			});
		});
		socket.on("unexpected-response", (_request, response) =>
			done(response.statusCode ?? null, "refused"),
		);
		socket.on("error", (error) => done(null, safeError(error).slice(0, 80)));
	});
}

// ---------------------------------------------------------------------------
// Guest probe scripts.

const LISTENERS_PY = `
import socket, threading
def serve(family, host, port):
    try:
        s = socket.socket(family, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if family == socket.AF_INET6:
            s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        s.bind((host, port)); s.listen(16)
        while True:
            c, _ = s.accept(); c.sendall(b"BUILDER-SERVICE\\n"); c.close()
    except Exception:
        pass
import sys
for spec in sys.argv[1:]:
    host, port = spec.rsplit(":", 1)
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    threading.Thread(target=serve, args=(fam, host, int(port)), daemon=True).start()
threading.Event().wait()
`;

const CONNECT_PY = `
import json, socket, sys, errno
out = {}
for spec in sys.argv[1:]:
    host, port = spec.rsplit(":", 1)
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_STREAM); s.settimeout(4)
    try:
        s.connect((host, int(port))); out[spec] = "open"
    except socket.timeout:
        out[spec] = "timeout"
    except ConnectionRefusedError:
        out[spec] = "refused"
    except OSError as e:
        out[spec] = errno.errorcode.get(e.errno, "oserror")
    finally:
        s.close()
print(json.dumps(out))
`;

/** Unix socket connect + X11 handshake without credentials; 1 = accepted, 0 = refused. */
const UNIX_PY = `
import json, socket, sys
out = {}
for path in sys.argv[1:]:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(4)
    try:
        s.connect(path)
        if path.startswith("/tmp/.X11-unix/"):
            s.sendall(b"l\\x00\\x0b\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00")
            first = s.recv(1)
            out[path] = "x11-accepted" if first == b"\\x01" else "x11-refused"
        else:
            out[path] = "connected"
    except PermissionError:
        out[path] = "EACCES"
    except FileNotFoundError:
        out[path] = "ENOENT"
    except OSError as e:
        out[path] = "oserror:" + str(e.errno)
    finally:
        s.close()
print(json.dumps(out))
`;

function pythonCommand(source: string, args: string[]) {
	return `printf %s ${b64(source)} | base64 -d > /tmp/.vmsec-$$.py && python3 /tmp/.vmsec-$$.py ${args.map(sh).join(" ")}; status=$?; rm -f /tmp/.vmsec-$$.py; exit $status`;
}

// ---------------------------------------------------------------------------
// A wrangler-backed Artifacts namespace, so the product's memory adapter
// (credentials, clone script, scrub) runs unchanged from this machine.

async function wranglerArtifacts(args: string[]) {
	const { stdout } = await run(
		"pnpm",
		["exec", "wrangler", "artifacts", ...args],
		{
			timeout: 90_000,
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	return stdout;
}
const jsonOf = (text: string) =>
	JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
const cliArtifacts: ArtifactsNamespace = {
	async create(name) {
		for (let attempt = 1; ; attempt++) {
			try {
				await wranglerArtifacts([
					"repos",
					"create",
					name,
					"--namespace",
					MEMORY_NAMESPACE,
				]);
				// Visible to `get` before the adapter asks for it.
				for (let wait = 0; wait < 6; wait++) {
					const seen = await wranglerArtifacts([
						"repos",
						"get",
						name,
						"--namespace",
						MEMORY_NAMESPACE,
						"--json",
					]).then(
						() => true,
						() => false,
					);
					if (seen) break;
					console.log("Memory repo created but not visible yet; waiting.");
					await delay(5000);
				}
				return { remote: "" };
			} catch (error) {
				const text = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
				if (/already exists|conflict|409/i.test(text))
					throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
				console.log(
					`Memory repo create attempt ${attempt} failed: ${safeError(error).slice(0, 120)}`,
				);
				if (attempt >= 3) throw error;
				await delay(5000);
			}
		}
	},
	async get(name) {
		let info: Record<string, unknown> | null = null;
		for (let attempt = 1; attempt <= 3 && !info; attempt++) {
			try {
				info = jsonOf(
					await wranglerArtifacts([
						"repos",
						"get",
						name,
						"--namespace",
						MEMORY_NAMESPACE,
						"--json",
					]),
				);
			} catch (error) {
				const text = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
				if (/not found|404/i.test(text) && attempt === 1)
					throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
				if (attempt < 3) await delay(5000);
			}
		}
		if (!info)
			throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
		return {
			info: async () => ({ remote: String(info.remote) }),
			async createToken(scope = "write", ttl = MEMORY_TOKEN_TTL_SECONDS) {
				const issued = jsonOf(
					await wranglerArtifacts([
						"repos",
						"issue-token",
						name,
						"--namespace",
						MEMORY_NAMESPACE,
						"--scope",
						scope,
						"--ttl",
						String(ttl),
						"--json",
					]),
				);
				return { plaintext: String(issued.plaintext) };
			},
			// No local revoke: the CLI has none. Revocation runs in the Worker.
			log: async () => [],
			readCommit: async () => null,
			readTree: async () => null,
			readBlob: async () => null,
		};
	},
	async delete(name) {
		await wranglerArtifacts([
			"repos",
			"delete",
			name,
			"--namespace",
			MEMORY_NAMESPACE,
			"-y",
		]);
		return true;
	},
};

// ---------------------------------------------------------------------------
// Local servers: the preview authorizer (behind a quick tunnel, since the
// development web app is not publicly deployed) and the Git mock.

function listen(server: Server) {
	localServers.push(server);
	return new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as AddressInfo).port),
		),
	);
}

function toRequest(request: IncomingMessage, origin: string) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers))
		if (typeof value === "string") headers.set(key, value);
		else if (Array.isArray(value))
			for (const item of value) headers.append(key, item);
	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	return new Request(`${origin}${request.url}`, {
		method: request.method,
		headers,
		body: hasBody ? (Readable.toWeb(request) as ReadableStream) : undefined,
		duplex: "half",
	} as RequestInit);
}

async function sendResponse(response: Response, out: ServerResponse) {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	out.writeHead(response.status, headers);
	if (response.body) Readable.fromWeb(response.body as never).pipe(out);
	else out.end();
}

async function startAuthorizerTunnel() {
	const port = await listen(
		createHttpServer((request, out) => {
			const url = new URL(request.url ?? "/", "http://local");
			if (url.pathname !== "/api/vm-edge/authorize") {
				out.writeHead(404).end();
				return;
			}
			void authorizePreviewRequest(toRequest(request, "http://local")).then(
				(response) => sendResponse(response, out),
			);
		}),
	);
	const child = spawn(
		"cloudflared",
		["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	tunnel = child;
	const origin = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Quick tunnel did not start.")),
			60_000,
		);
		const scan = (chunk: Buffer) => {
			const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(
				chunk.toString(),
			);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		};
		child.stdout?.on("data", scan);
		child.stderr?.on("data", scan);
	});
	// The quick tunnel's name resolves a few seconds after it is printed.
	await pollProbe(
		`${origin}/api/vm-edge/authorize`,
		{},
		(probe) => probe.status === 403,
		90_000,
	);
	return origin;
}

/** git http-backend as an HTTP server (the "GitHub" behind the mocked proxy). */
function gitBackend(root: string) {
	return createHttpServer((request, out) => {
		const url = new URL(request.url ?? "/", "http://local");
		const child = spawn("git", ["http-backend"], {
			env: {
				PATH: process.env.PATH,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				REMOTE_USER: "proof",
				REMOTE_ADDR: "127.0.0.1",
				REQUEST_METHOD: request.method ?? "GET",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: request.headers["content-type"] ?? "",
				...(request.headers["content-length"]
					? { CONTENT_LENGTH: request.headers["content-length"] }
					: {}),
			},
		});
		request.pipe(child.stdin);
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("close", () => {
			const all = Buffer.concat(chunks);
			const split = all.indexOf("\r\n\r\n");
			const head = all.subarray(0, split).toString();
			const headers: Record<string, string> = {};
			let status = 200;
			for (const line of head.split("\r\n")) {
				const [key, ...rest] = line.split(":");
				const value = rest.join(":").trim();
				if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else if (key) headers[key] = value;
			}
			out.writeHead(status, headers);
			out.end(all.subarray(split + 4));
		});
	});
}

// ---------------------------------------------------------------------------

const user = await createEvalUser({ label: "vm-security-proof" });
cleanup.push(`eval user ${user.userId} created`);
const scope: { userId: string; projectId: string; sessionId?: string } = {
	userId: user.userId,
	projectId: user.project.projectId,
};
let vm = "";
let builderHome = "";
let credentialPassword = "";
let memoryToken = "";
let memoryRemote = "";
const hostnames = new Set<string>();

async function createChatVm(slug: string, snapshotId: string, purpose: string) {
	const created = await client.vms.create({
		...productCreateVmFields({ slug, snapshotId }),
		ttlSeconds: VM_CAP_SECONDS + 600,
		maxRunTotalSeconds: VM_CAP_SECONDS,
		automaticRestart: false,
		metadata: { purpose },
	} as never);
	vms.add(created.vmId);
	await user.trackVm(created.vmId);
	await waitUntilVmRunning(created.vm, "VM security proof");
	return created.vmId;
}

try {
	// ---- setup: chat, VM from the project's prepared environment ------------
	const db = database();
	const session = await insertAgentSession({
		userId: user.userId,
		projectId: user.project.projectId,
		workspaceId: user.project.workspaceId,
		harness: "codex",
		title: "VM security proof",
	});
	scope.sessionId = session.id;
	const template = (
		await db.query<{ template_snapshot_id: string | null }>(
			"select template_snapshot_id from workspace where id=$1",
			[user.project.workspaceId],
		)
	).rows[0]?.template_snapshot_id;
	if (!template)
		throw new Error("The copied project has no prepared environment.");
	vm = await createChatVm(
		`ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
		template,
		"ytimesy-vm-security-proof",
	);
	await saveAgentSessionProviderRef(session.id, vm);
	await db.query("update agent_session set status='ready' where id=$1", [
		session.id,
	]);
	const who = (await execOk(vm, 'printf "%s %s" "$(id -un)" "$HOME"', 15_000))
		.trim()
		.split(" ");
	builderHome = who[1];
	console.log(
		`Setup: chat VM running (builder user ${who[0]}, home ${builderHome}).`,
	);

	// ---- per-turn metadata block (api-turn-workspace blockGuestMetadata) ----
	const blocks = [
		await exec(vm, guestMetadataBlockCommand(), 30_000),
		await exec(vm, guestMetadataBlockCommand(), 30_000),
	];
	const ruleCounts = (
		await exec(
			vm,
			GUEST_METADATA_DESTINATIONS.map(
				([table, destination]) =>
					`printf '%s ' "$(sudo -n ${table} -S OUTPUT 2>/dev/null | grep -c -- '-d ${destination}/[0-9]* -j REJECT')"`,
			).join("; "),
			15_000,
		)
	).stdout
		.trim()
		.split(/\s+/);
	record(
		"3",
		"per-turn metadata block: REJECT for 169.254.169.254, 169.254.170.2, fd00:ec2::254 (run twice: idempotent)",
		blocks.every((b) => b.exitCode === 0) &&
			ruleCounts.length === GUEST_METADATA_DESTINATIONS.length &&
			ruleCounts.every((n) => n === "1"),
		`exits ${blocks.map((b) => b.exitCode).join(",")}; rule count per destination ${ruleCounts.join(",")}`,
	);

	// ---- desktop, started the product's way ---------------------------------
	// ensureDesktopProcesses is what startWorkspaceDesktop runs on the VM.
	const productStart = await ensureDesktopProcesses(machines, vm);
	const productListening = (
		await exec(vm, "ss -ltnH | grep -c ':6080 ' || true", 15_000)
	).stdout.trim();
	record(
		"1",
		"desktop start on the product path (no self-kill, was exit 143)",
		productStart.exitCode === 0 && productListening !== "0",
		`exit ${productStart.exitCode}${/Terminated/.test(productStart.stderr) ? " (Terminated)" : ""}; viewer listening: ${productListening !== "0"}`,
	);
	if (productStart.exitCode !== 0 || productListening === "0") {
		const fromFile = await exec(vm, START_WORKSPACE_DESKTOP, 300_000);
		console.log(`Workaround: start script rerun: exit ${fromFile.exitCode}.`);
	}
	const restart = await ensureDesktopProcesses(machines, vm);
	record(
		"1",
		"desktop restart on the product path",
		restart.exitCode === 0,
		`exit ${restart.exitCode}`,
	);
	// VNC: Unix socket only, password required.
	const vncTcp = (
		await exec(
			vm,
			"sudo -n ss -ltnpH 2>/dev/null | grep -E ':590[0-9][[:space:]]' | awk '{print $4}' | tr '\\n' ' '",
			15_000,
		)
	).stdout.trim();
	const vncArgs = (await exec(vm, "pgrep -a -x x11vnc | head -1", 15_000))
		.stdout;
	record(
		"1",
		"x11vnc: no TCP listener on 590x (127.0.0.1, [::]), Unix socket + password file",
		vncTcp === "" &&
			vncArgs.includes("-unixsock") &&
			vncArgs.includes("-passwdfile") &&
			vncArgs.includes("-rfbport 0"),
		`TCP listeners: ${vncTcp || "none"}; -unixsock ${vncArgs.includes("-unixsock")}, -passwdfile ${vncArgs.includes("-passwdfile")}, -noipv6 ${vncArgs.includes("-noipv6")}`,
	);
	const rfbSecurity = (
		await exec(
			vm,
			pythonCommand(RFB_SECURITY_PY, [`${builderHome}/.ytimesy/vnc/rfb.sock`]),
			30_000,
		)
	).stdout.trim();
	record(
		"1",
		"VNC handshake (as the builder, on the socket) offers only password auth",
		rfbRequiresPassword(rfbSecurity),
		`${rfbSecurity || "no answer"} (1 = none, 2 = VNC password, 18/19 = TLS/VeNCrypt)`,
	);
	// A VNC server on TCP makes the start script stop x11vnc and refuse.
	await execOk(
		vm,
		`printf %s ${b64(LISTENERS_PY)} | base64 -d > /tmp/vmsec-vnc-tcp.py && (nohup setsid python3 /tmp/vmsec-vnc-tcp.py 127.0.0.1:5901 >/dev/null 2>&1 &) && sleep 2`,
		20_000,
	);
	const refused = await exec(vm, START_WORKSPACE_DESKTOP, 300_000);
	const vncAfterRefusal = (
		await exec(vm, "pgrep -c -x x11vnc || true", 15_000)
	).stdout.trim();
	await exec(vm, "pkill -f '[v]msec-vnc-tcp'; sleep 1", 15_000);
	const recovered = await exec(vm, START_WORKSPACE_DESKTOP, 300_000);
	record(
		"1",
		"desktop refused while a VNC server listens on TCP (then recovers)",
		refused.exitCode !== 0 &&
			/listened on TCP/.test(refused.stderr) &&
			vncAfterRefusal === "0" &&
			recovered.exitCode === 0,
		`with TCP 5901: exit ${refused.exitCode}, refusal message ${/listened on TCP/.test(refused.stderr)}, x11vnc running ${vncAfterRefusal}; after removing it: exit ${recovered.exitCode}`,
	);
	await publishDesktopViewer(machines, vm);
	credentialPassword = desktopViewerCredential(vm).split(":")[1];
	const deskHost = desktopEdgeHostname(vm);
	hostnames.add(deskHost);
	const deskUrl = `https://${deskHost}/websockify`;
	const deskWs = `wss://${deskHost}/websockify`;
	console.log("Setup: desktop running and viewer route published.");

	// ---- 1. desktop route credentials ---------------------------------------
	const wrong = `Basic ${Buffer.from(`ytimesy:${randomBytes(20).toString("hex")}`).toString("base64")}`;
	const right = desktopViewerAuthorization(vm);
	const noCreds = await pollProbe(
		deskUrl,
		{},
		(p) => p.status !== null && p.status < 500 && p.status !== 404,
	);
	record(
		"1",
		"desktop route, plain HTTP, no credentials",
		noCreds.status === 401 ||
			noCreds.status === 403 ||
			(noCreds.status === 405 && !noCreds.body.includes("RFB")),
		`HTTP ${shown(noCreds)}${noCreds.status === 405 ? " (websockify serves no pages; nothing returned)" : ""}`,
	);
	const wrongCreds = await httpProbe(deskUrl, {
		headers: { authorization: wrong },
	});
	record(
		"1",
		"desktop route, plain HTTP, wrong credentials",
		wrongCreds.status === 401 ||
			wrongCreds.status === 403 ||
			(wrongCreds.status === 405 && !wrongCreds.body.includes("RFB")),
		`HTTP ${shown(wrongCreds)}${wrongCreds.status === 405 ? " (websockify serves no pages; nothing returned)" : ""}`,
	);
	const wsNone = await wsProbe(deskWs, {});
	record(
		"1",
		"desktop WebSocket, no credentials",
		wsNone.status === 401 || wsNone.status === 403,
		`handshake ${wsNone.status ?? wsNone.detail}`,
	);
	const wsWrong = await wsProbe(deskWs, { headers: { authorization: wrong } });
	record(
		"1",
		"desktop WebSocket, wrong credentials",
		wsWrong.status === 401 || wsWrong.status === 403,
		`handshake ${wsWrong.status ?? wsWrong.detail}`,
	);
	const wsRight = await wsProbe(deskWs, {
		headers: { authorization: right },
		firstMessage: true,
	});
	record(
		"1",
		"desktop WebSocket, server-held credentials: VNC answers (no regression)",
		wsRight.status === 101 && wsRight.detail.includes("RFB "),
		`handshake ${wsRight.status ?? ""} ${wsRight.detail}`,
	);

	// ---- 5. cross-site WebSocket --------------------------------------------
	const wsForeignDesk = await wsProbe(deskWs, {
		origin: "https://evil.example",
	});
	record(
		"5",
		"VM desktop route, foreign Origin without credentials",
		wsForeignDesk.status === 401 || wsForeignDesk.status === 403,
		`handshake ${wsForeignDesk.status ?? wsForeignDesk.detail}`,
	);
	// The app's /api/desktop and /api/terminal sockets: the product's Node
	// upgrade handler (development's web Worker is not publicly deployed).
	const appServer = createHttpServer((_request, out) =>
		out.writeHead(404).end(),
	);
	const appPort = await listen(appServer);
	attachTerminalUpgrade(appServer);
	const appOrigin = new URL(process.env.APP_URL ?? "").origin;
	const desktopSocket = `ws://127.0.0.1:${appPort}/api/desktop?projectId=${scope.projectId}&sessionId=${scope.sessionId}`;
	const terminalSocket = `ws://127.0.0.1:${appPort}/api/terminal?projectId=${scope.projectId}`;
	for (const [label, url] of [
		["/api/desktop", desktopSocket],
		["/api/terminal", terminalSocket],
	] as const) {
		const foreign = await wsProbe(url, { origin: "https://evil.example" });
		record(
			"5",
			`${label}, foreign Origin`,
			foreign.status === 403,
			`handshake ${foreign.status ?? foreign.detail}`,
		);
		const missing = await wsProbe(url, {});
		record(
			"5",
			`${label}, no Origin`,
			missing.status === 403,
			`handshake ${missing.status ?? missing.detail}`,
		);
		const trusted = await wsProbe(url, { origin: appOrigin });
		record(
			"5",
			`${label}, app Origin (control: passes the origin gate)`,
			trusted.status === 101,
			`handshake ${trusted.status ?? trusted.detail}; session then requires sign-in`,
		);
	}

	// ---- a user app on the preview port, as the builder ----------------------
	const marker = `vmsec-${randomBytes(8).toString("hex")}`;
	await execOk(
		vm,
		`mkdir -p /tmp/vmsec-app && printf %s ${sh(marker)} > /tmp/vmsec-app/index.html && cd /tmp/vmsec-app && (nohup setsid python3 -m http.server ${PREVIEW_PORT} --bind 0.0.0.0 >/dev/null 2>&1 &) && sleep 1`,
		20_000,
	);

	// ---- 4. private preview ---------------------------------------------------
	let previewOrigin = "";
	let previewCookie = "";
	try {
		const authorizerOrigin = await startAuthorizerTunnel();
		cleanup.push("local quick tunnel started for the preview authorizer");
		const authorizer = await machines.ensureEdgeAuthorizer?.({
			url: edgeAuthorizerUrl(authorizerOrigin),
			headers: { [EDGE_AUTHORIZER_HEADER]: edgeAuthorizerKey() },
			protectedCookies: [PREVIEW_COOKIE],
		});
		if (!authorizer) throw new Error("No forward auth.");
		forwardAuthIds.add(authorizer);
		const route = await machines.publishHttpRoute?.(WorkspaceId(vm), {
			hostname: previewHostname(vm, PREVIEW_PORT),
			port: PREVIEW_PORT,
			forwardAuthId: authorizer,
		});
		if (!route) throw new Error("No preview route.");
		previewOrigin = route.origin;
		hostnames.add(new URL(route.origin).hostname);
		const anonymous = await pollProbe(
			`${route.origin}/`,
			{},
			(p) => p.status !== null && p.status !== 404 && p.status < 500,
		);
		record(
			"4",
			"preview, unauthenticated",
			anonymous.status !== null &&
				anonymous.status !== 200 &&
				!anonymous.body.includes(marker),
			`HTTP ${shown(anonymous)}, app content ${anonymous.body.includes(marker) ? "served" : "not served"}`,
		);
		const forged = await httpProbe(`${route.origin}/`, {
			headers: { cookie: `${PREVIEW_COOKIE}=${b64("{}")}.forged` },
		});
		record(
			"4",
			"preview, forged session cookie",
			forged.status !== 200 && !forged.body.includes(marker),
			`HTTP ${shown(forged)}`,
		);
		const badLogin = await httpProbe(
			`${route.origin}/__ytimesy/preview?t=${b64("{}")}.x`,
		);
		record(
			"4",
			"preview, forged login grant",
			badLogin.status !== 303 && !badLogin.setCookie,
			`HTTP ${shown(badLogin)}, cookie ${badLogin.setCookie ? "set" : "not set"}`,
		);
		if (!scope.sessionId) throw new Error("The probe chat was not created.");
		const login = await httpProbe(
			await previewLoginUrl(route.origin, {
				ruleId: route.ruleId,
				userId: scope.userId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
			}),
		);
		previewCookie = (login.setCookie ?? "").split(";")[0];
		const granted = previewCookie
			? await httpProbe(`${route.origin}/`, {
					headers: { cookie: previewCookie },
				})
			: login;
		record(
			"4",
			"preview, authenticated grant (login link -> cookie -> app)",
			login.status === 303 &&
				Boolean(previewCookie) &&
				granted.status === 200 &&
				granted.body.includes(marker),
			`login HTTP ${shown(login)}, cookie ${previewCookie ? "set" : "missing"}, app HTTP ${shown(granted)}`,
		);
	} catch (error) {
		record("4", "preview", false, `could not run: ${safeError(error)}`);
	}

	// ---- 2. withdrawn routes ----------------------------------------------------
	const shareHost = sharedPreviewHostname(vm, PREVIEW_PORT);
	hostnames.add(shareHost);
	await machines.publishHttpRoute?.(WorkspaceId(vm), {
		hostname: shareHost,
		port: PREVIEW_PORT,
	});
	const shared = await pollProbe(
		`https://${shareHost}/`,
		{},
		(p) => p.status === 200 && p.body.includes(marker),
	);
	record(
		"2",
		"shared link serves the app (control)",
		shared.status === 200 && shared.body.includes(marker),
		`HTTP ${shown(shared)}`,
	);
	await machines.withdrawHttpRoutes?.(WorkspaceId(vm), ["share"], PREVIEW_PORT);
	const unshared = await pollProbe(
		`https://${shareHost}/`,
		{},
		(p) => !p.body.includes(marker),
		90_000,
	);
	record(
		"2",
		"shared link after sharing off",
		!unshared.body.includes(marker) && unshared.status !== 200,
		`HTTP ${shown(unshared)}`,
	);
	if (previewOrigin && previewCookie) {
		await machines.withdrawHttpRoutes?.(WorkspaceId(vm), ["pv"], PREVIEW_PORT);
		const gone = await pollProbe(
			`${previewOrigin}/`,
			{ headers: { cookie: previewCookie } },
			(p) => !p.body.includes(marker),
			90_000,
		);
		record(
			"2",
			"withdrawn preview route with a valid cookie",
			!gone.body.includes(marker) && gone.status !== 200,
			`HTTP ${shown(gone)}`,
		);
	}
	await withdrawDesktopViewer(machines, vm);
	const deskGone = await pollProbe(
		deskUrl,
		{ headers: { authorization: right } },
		(p) => p.status !== 401 && p.status !== 405 && p.status !== 400,
		90_000,
	);
	const deskGoneWs = await wsProbe(deskWs, {
		headers: { authorization: right },
	});
	record(
		"2",
		"withdrawn desktop route with right credentials",
		deskGoneWs.status !== 101 && deskGone.status !== 401,
		`HTTP ${shown(deskGone)}, handshake ${deskGoneWs.status ?? deskGoneWs.detail}`,
	);
	await publishDesktopViewer(machines, vm);

	// ---- 3. egress from the VM, as builder and reader --------------------------
	const reader = readerWorkspaceMachines(machines, {
		sessionId: `vmsec-${randomUUID()}`,
		sessionRoot: `/tmp/ytimesy-sessions/vmsec-${randomUUID()}`,
		scope: (text) => text,
	});
	const asReader = (command: string, ms = 60_000) =>
		reader.exec(WorkspaceId(vm), command, ms);
	const readerId = (await asReader("id -un", 30_000)).stdout.trim();
	console.log(
		`Setup: reader user prepared (${readerId === READER_LINUX_USER ? READER_LINUX_USER : `unexpected: ${readerId}`}).`,
	);
	const gateway = (
		await exec(vm, "ip -4 route show default | awk '{print $3; exit}'", 15_000)
	).stdout.trim();
	const gateway6 = (
		await exec(vm, "ip -6 route show default | awk '{print $3; exit}'", 15_000)
	).stdout.trim();
	const privateTargets = [
		"169.254.169.254:80",
		"169.254.169.254:443",
		"fd00:ec2::254:80",
		"169.254.170.2:80",
		"100.100.100.200:80",
		"10.0.0.1:80",
		"10.255.255.1:443",
		"172.16.0.1:80",
		"172.31.255.1:443",
		"192.168.0.1:80",
		"192.168.1.1:443",
		"100.64.0.1:80",
	];
	const publicControl = "1.1.1.1:443";
	for (const [label, runAs] of [
		["builder", (command: string) => exec(vm, command, 120_000)],
		["reader", (command: string) => asReader(command, 120_000)],
	] as const) {
		const output = await runAs(
			pythonCommand(CONNECT_PY, [
				...privateTargets,
				publicControl,
				...(gateway ? [`${gateway}:80`, `${gateway}:22`] : []),
			]),
		);
		const states = JSON.parse(output.stdout.trim() || "{}") as Record<
			string,
			string
		>;
		const reachable = privateTargets.filter(
			(target) => states[target] === "open",
		);
		record(
			"3",
			`${label}: metadata and RFC1918/CGNAT probes`,
			reachable.length === 0 && Object.keys(states).length > 0,
			reachable.length
				? `open: ${reachable.join(", ")}`
				: `none open (${[...new Set(privateTargets.map((t) => states[t]))].join("/")})`,
		);
		const metadataHttp = await runAs(
			"curl -sS -m 4 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/ 2>/dev/null; echo; curl -sS -m 4 -o /dev/null -w '%{http_code}' -g 'http://[fd00:ec2::254]/latest/meta-data/' 2>/dev/null; echo; curl -sS -m 4 -o /dev/null -w '%{http_code}' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null; echo; curl -sS -m 4 -o /dev/null -w '%{http_code}' http://169.254.170.2/ 2>/dev/null; echo",
		);
		const codes = metadataHttp.stdout
			.trim()
			.split("\n")
			.map((code) => code.trim() || "000");
		record(
			"3",
			`${label}: metadata HTTP (GET 169.254.169.254, GET fd00:ec2::254, AWS PUT /latest/api/token, GET 169.254.170.2)`,
			codes.length === 4 && codes.every((code) => code === "000"),
			`HTTP ${codes.join(", ")} (000 = no connection; the PUT was 200 before)`,
		);
		record(
			"3",
			label === "builder"
				? "builder: public egress control"
				: "reader: no network at all (public address unreachable)",
			label === "builder"
				? states[publicControl] === "open"
				: states[publicControl] !== "open",
			`1.1.1.1:443 ${states[publicControl]}${gateway ? `; gateway ${gateway}:80 ${states[`${gateway}:80`]}, :22 ${states[`${gateway}:22`]} (info)` : ""}${gateway6 ? "; IPv6 default route present (info)" : ""}`,
		);
	}

	const metadata = await exec(
		vm,
		[
			"echo \"GET /: $(curl -s -m 4 -o /dev/null -w '%{http_code}' http://169.254.169.254/), server: $(curl -s -m 4 -D - -o /dev/null http://169.254.169.254/ | grep -i '^server:' | tr -d '\\r' | cut -c1-40)\"",
			"echo \"AWS IMDSv2 token PUT: $(curl -s -m 4 -o /dev/null -w '%{http_code}' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)\"",
			"echo \"GCP computeMetadata: $(curl -s -m 4 -o /dev/null -w '%{http_code}' -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/)\"",
			"echo \"Azure IMDS: $(curl -s -m 4 -o /dev/null -w '%{http_code}' -H 'Metadata: true' 'http://169.254.169.254/metadata/instance?api-version=2021-02-01')\"",
			"echo \"auth challenge: $(curl -s -m 4 -D - -o /dev/null http://169.254.169.254/latest/meta-data/ | grep -i '^www-authenticate:' | tr -d '\\r' | cut -c1-60)\"",
		].join("\n"),
		60_000,
	);
	for (const line of metadata.stdout.trim().split("\n"))
		console.log(`Diagnostics (3, 169.254.169.254): ${line}`);

	// ---- 6. reader isolation (H2) ------------------------------------------------
	// Builder-side state a mid-turn VM holds: loopback services, the secrets
	// directory, a Git proxy config and the memory clone with its token.
	const chrome = await exec(
		vm,
		`bin=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true); if [ -n "$bin" ]; then (nohup setsid "$bin" --headless=new --no-sandbox --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/ytimesy-chrome-profile about:blank >/dev/null 2>&1 &); echo chrome; else echo none; fi`,
		20_000,
	);
	const listenerSpecs = [
		"127.0.0.1:5678",
		"::1:5678",
		"127.0.0.1:9229",
		"::1:9229",
		"127.0.0.1:40123",
		"::1:40123",
		"::1:9222",
		...(chrome.stdout.includes("chrome") ? [] : ["127.0.0.1:9222"]),
	];
	await execOk(
		vm,
		`printf %s ${b64(LISTENERS_PY)} | base64 -d > /tmp/vmsec-listeners.py && (nohup setsid python3 /tmp/vmsec-listeners.py ${listenerSpecs.join(" ")} >/dev/null 2>&1 &) && sleep 4`,
		20_000,
	);
	await execOk(
		vm,
		`umask 077; mkdir -p ${AGENT_SECRETS_DIRECTORY} && printf 'PROOF_SECRET=%s\\n' ${sh(randomBytes(12).toString("hex"))} > ${AGENT_SECRETS_DIRECTORY}/agent.env && chmod 0700 ${AGENT_SECRETS_DIRECTORY}`,
		15_000,
	);
	// The Git proxy's private config, made the way withProxyGit makes it.
	const proxyDir = (
		await execOk(
			vm,
			"umask 077; mktemp -d /tmp/ytimesy-git-proxy-XXXXXXXX",
			15_000,
		)
	).trim();
	await machines.writeTextFile(
		WorkspaceId(vm),
		`${proxyDir}/config`,
		`[http "https://proof.invalid/"]\n\textraHeader = "x-ytimesy-git-grant: proof-${randomBytes(8).toString("hex")}"\n`,
	);
	// The memory clone, made by the product's clone script with a real token.
	await user.setMemory("full");
	registerMemoryRepos(cliArtifacts);
	const repo = memoryRepo(user.memoryRepo);
	if (!repo) throw new Error("Memory repo adapter unavailable.");
	const credentials = await repo.credentials(MEMORY_TOKEN_TTL_SECONDS);
	memoryToken = credentials.token;
	memoryRemote = credentials.remote;
	cleanup.push("memory repo created for the eval user");
	const cloned = await exec(vm, memoryCloneScript(credentials), 90_000);
	const memoryConfig = `${builderHome}/memory/.git/config`;
	const configMid = (await exec(vm, `cat ${sh(memoryConfig)}`, 15_000)).stdout;
	console.log(
		`Setup: memory clone ${cloned.exitCode === 0 ? "ready" : `failed (${cloned.exitCode})`}; token in clone mid-turn: ${configMid.includes(memoryToken)}.`,
	);

	const loopbackTargets = [
		"127.0.0.1:5900",
		"::1:5900",
		"127.0.0.1:6080",
		"::1:6080",
		"127.0.0.1:9222",
		"::1:9222",
		"127.0.0.1:5678",
		"::1:5678",
		"127.0.0.1:9229",
		"::1:9229",
		"127.0.0.1:40123",
		"::1:40123",
		`127.0.0.1:${PREVIEW_PORT}`,
	];
	const ownAddress = (
		await exec(vm, "hostname -I | awk '{print $1}'", 15_000)
	).stdout.trim();
	const ownTargets = ownAddress
		? [`${ownAddress}:6080`, `${ownAddress}:${PREVIEW_PORT}`]
		: [];
	const builderStates = JSON.parse(
		(
			await exec(
				vm,
				pythonCommand(CONNECT_PY, [...loopbackTargets, ...ownTargets]),
			)
		).stdout.trim() || "{}",
	) as Record<string, string>;
	const readerStates = JSON.parse(
		(
			await asReader(
				pythonCommand(CONNECT_PY, [...loopbackTargets, ...ownTargets]),
			)
		).stdout.trim() || "{}",
	) as Record<string, string>;
	const builderOpen = Object.entries(builderStates)
		.filter(([, state]) => state === "open")
		.map(([target]) => target);
	const readerOpen = Object.entries(readerStates)
		.filter(([, state]) => state === "open")
		.map(([target]) => target);
	record(
		"6",
		"reader: loopback TCP (VNC 5900, viewer 6080, DevTools 9222, debuggers 5678/9229/40123, dev server) on 127.0.0.1 and ::1",
		readerOpen.filter((t) => !ownTargets.includes(t)).length === 0 &&
			Object.keys(readerStates).length > 0,
		`reader open: ${readerOpen.filter((t) => !ownTargets.includes(t)).join(", ") || "none"}; builder control open: ${builderOpen.filter((t) => !ownTargets.includes(t)).length}/${loopbackTargets.length} (DevTools via ${chrome.stdout.includes("chrome") ? "Chrome" : "stand-in listener"})`,
	);
	if (ownTargets.length)
		record(
			"6",
			"reader: viewer/dev server via the VM's own address",
			readerOpen.filter((t) => ownTargets.includes(t)).length === 0,
			`reader open: ${readerOpen.filter((t) => ownTargets.includes(t)).join(", ") || "none"}`,
		);
	const xSocket = "/tmp/.X11-unix/X0";
	const vncSocket = `${builderHome}/.ytimesy/vnc/rfb.sock`;
	const unixReader = JSON.parse(
		(
			await asReader(pythonCommand(UNIX_PY, [xSocket, vncSocket]))
		).stdout.trim() || "{}",
	) as Record<string, string>;
	const xReader = await asReader(
		`DISPLAY=:0 XAUTHORITY=${sh(DESKTOP_XAUTHORITY)} timeout 5 xdpyinfo >/dev/null 2>&1; echo $?`,
	);
	const xBuilder = await exec(
		vm,
		`DISPLAY=:0 XAUTHORITY=${sh(DESKTOP_XAUTHORITY)} timeout 5 xdpyinfo >/dev/null 2>&1; echo $?`,
	);
	record(
		"6",
		"reader: X display :0",
		unixReader[xSocket] !== "x11-accepted" && xReader.stdout.trim() !== "0",
		`no-cookie handshake ${unixReader[xSocket]}, xdpyinfo exit ${xReader.stdout.trim()} (builder control exit ${xBuilder.stdout.trim()})`,
	);
	record(
		"6",
		"reader: VNC Unix socket",
		unixReader[vncSocket] !== "connected",
		`${unixReader[vncSocket]}`,
	);
	const readable = async (path: string) => {
		const result = await asReader(
			`cat -- ${sh(path)} 2>&1 >/dev/null; echo "exit=$?"`,
		);
		return {
			denied: !/exit=0/.test(result.stdout),
			detail: /Permission denied/.test(result.stdout)
				? "permission denied"
				: /No such file/.test(result.stdout)
					? "no such file"
					: result.stdout.trim().slice(-20),
		};
	};
	for (const [label, path] of [
		[
			"desktop viewer credential",
			`${DESKTOP_PRIVATE_DIRECTORY}/viewer.credential`,
		],
		["VNC password file", `${DESKTOP_PRIVATE_DIRECTORY}/vnc.passwd`],
		["Git proxy config", `${proxyDir}/config`],
		["agent secrets env", `${AGENT_SECRETS_DIRECTORY}/agent.env`],
		["memory clone config (token)", memoryConfig],
		["X cookie (private Xauthority)", DESKTOP_XAUTHORITY],
	] as const) {
		const outcome = await readable(path);
		record("6", `reader: read ${label}`, outcome.denied, outcome.detail);
	}
	const memoryGrep = await asReader(
		`grep -rl -- ${sh(memoryToken.slice(0, 24))} ${sh(`${builderHome}/memory`)} /tmp 2>/dev/null | wc -l`,
	);
	record(
		"6",
		"reader: memory token found anywhere it can read (~/memory, /tmp)",
		memoryGrep.stdout.trim() === "0",
		`${memoryGrep.stdout.trim()} file(s)`,
	);
	const psOut = await asReader(
		"ps -eww -o args 2>/dev/null; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' ' '",
	);
	record(
		"6",
		"reader: process list / cmdline / environ reveal the viewer password",
		!psOut.stdout.includes(credentialPassword) &&
			psOut.stdout.includes("websockify"),
		`password ${psOut.stdout.includes(credentialPassword) ? "VISIBLE" : "not visible"}; websockify ${psOut.stdout.includes("websockify") ? "visible (process seen)" : "not seen"}`,
	);

	const modes = (
		await exec(
			vm,
			`stat -c %a ${sh(`${builderHome}/memory`)} ${sh(`${builderHome}/memory/.git`)} ${sh(memoryConfig)} | tr '\\n' ' '`,
			15_000,
		)
	).stdout
		.trim()
		.split(/\s+/);
	record(
		"6",
		"memory clone modes (dir, .git, config) 0700/0700/0600",
		modes.join(" ") === "700 700 600",
		modes.join(" "),
	);
	const readerMemoryList = await asReader(
		`ls ${sh(`${builderHome}/memory`)} >/dev/null 2>&1; echo "exit=$?"`,
	);
	record(
		"6",
		"reader: list ~/memory",
		!/exit=0/.test(readerMemoryList.stdout),
		readerMemoryList.stdout.trim(),
	);
	const netns = (
		await asReader(
			"readlink /proc/self/ns/net; ip -o link 2>/dev/null | awk -F': ' '{print $2}' | tr '\\n' ','; echo; getent hosts example.com >/dev/null 2>&1 && echo dns-ok || echo dns-fail",
		)
	).stdout
		.trim()
		.split("\n");
	const builderNetns = (
		await exec(vm, "readlink /proc/self/ns/net", 15_000)
	).stdout.trim();
	record(
		"6",
		"reader runs in its own network namespace (lo only, no DNS)",
		netns[0] !== "" &&
			netns[0] !== builderNetns &&
			netns[1]?.replace(/,$/, "") === "lo" &&
			netns[2] === "dns-fail",
		`reader ns ${netns[0] === builderNetns ? "SAME as builder" : "own"}; links ${netns[1] ?? "?"}; ${netns[2] ?? "?"}`,
	);

	// What a researcher still needs, from inside the namespace.
	const checkout = (
		await machines.readTextFile(WorkspaceId(vm), "/tmp/ytimesy-project-cwd")
	)?.trim();
	const research = (
		await asReader(
			[
				checkout
					? `cd ${sh(checkout)} && echo "git log: $(git log -1 --format=%h >/dev/null 2>&1 && echo ok || echo fail)" && echo "grep: $(grep -rIl --exclude-dir=node_modules --exclude-dir=.git . . 2>/dev/null | head -1 >/dev/null && echo ok || echo fail)"`
					: 'echo "git log: no checkout"',
				'echo "own loopback server: $(cd "$HOME" && (python3 -m http.server 18080 --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > srv.pid) && sleep 1 && curl -s -m 3 -o /dev/null -w \'%{http_code}\' http://127.0.0.1:18080/; kill $(cat "$HOME/srv.pid") 2>/dev/null)"',
				"echo \"https fetch (registry.npmjs.org): $(curl -s -m 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ 2>/dev/null)\"",
			].join("\n"),
			90_000,
		)
	).stdout.trim();
	record(
		"6",
		"reader: code reading still works (git log, grep, its own loopback server)",
		/git log: ok/.test(research) &&
			/grep: ok/.test(research) &&
			/own loopback server: 200/.test(research),
		research.replaceAll("\n", "; "),
	);

	// A benchmark task container (hard-set's sudo route: the reader may run
	// only the route script as root, which docker-execs into the container).
	const dockerReady = await exec(
		vm,
		"sudo -n docker info >/dev/null 2>&1 && echo ready || echo missing",
		60_000,
	);
	if (!dockerReady.stdout.includes("ready")) {
		record("6", "reader: task container route", null, "docker unavailable");
	} else {
		const started = await exec(
			vm,
			"sudo -n docker rm -f vmsec-tb >/dev/null 2>&1; sudo -n docker run -d --name vmsec-tb --entrypoint sleep curlimages/curl:8.10.1 900 >/dev/null && echo started",
			240_000,
		);
		const route = `#!/bin/bash\n[ "$(id -u)" = 0 ] && [ "\${SUDO_USER:-}" = ${READER_LINUX_USER} ] || exit 2\nexec docker exec -u "$SUDO_UID:$SUDO_GID" vmsec-tb sh -c "$1"\n`;
		await execOk(
			vm,
			`printf %s ${b64(route)} | base64 -d > /tmp/vmsec-route && sudo -n install -m 0755 -o root -g root /tmp/vmsec-route /usr/local/bin/vmsec-route && printf '%s\\n' 'Defaults:${READER_LINUX_USER} !use_pty' '${READER_LINUX_USER} ALL=(root) NOPASSWD: /usr/local/bin/vmsec-route' > /tmp/vmsec-sudoers && sudo -n visudo -cqf /tmp/vmsec-sudoers && sudo -n install -m 0440 /tmp/vmsec-sudoers /etc/sudoers.d/zz-vmsec-route`,
			30_000,
		);
		const routed = (
			await asReader(
				`sudo -n /usr/local/bin/vmsec-route 'echo "routed:$(test -e /.dockerenv && echo container):$(id -u)"; echo "container public: $(curl -s -m 5 -o /dev/null -w %{http_code} https://1.1.1.1/)"; echo "container metadata PUT: $(curl -s -m 4 -o /dev/null -w %{http_code} -X PUT -H X-aws-ec2-metadata-token-ttl-seconds:60 http://169.254.169.254/latest/api/token)"; echo "container metadata GET: $(curl -s -m 4 -o /dev/null -w %{http_code} http://169.254.169.254/latest/meta-data/)"' 2>&1`,
				90_000,
			)
		).stdout.trim();
		record(
			"6",
			"reader: runs commands in a task container through the sudo route (works from its netns)",
			started.stdout.includes("started") && /routed:container:\d+/.test(routed),
			`container ${started.stdout.includes("started") ? "started" : `not started (${started.exitCode})`}; ${/routed:[^\n]*/.exec(routed)?.[0] ?? `no route output: ${routed.split("\n").at(-1)?.slice(0, 80) ?? ""}`}`,
		);
		const put = /container metadata PUT: (\d+)/.exec(routed)?.[1] ?? "?";
		const get = /container metadata GET: (\d+)/.exec(routed)?.[1] ?? "?";
		const pub = /container public: (\d+)/.exec(routed)?.[1] ?? "?";
		record(
			"3",
			"task container (docker, FORWARD path): metadata PUT /latest/api/token and GET",
			put === "000" && get === "000",
			`PUT ${put}, GET ${get} (000 = no connection); container public 1.1.1.1 HTTP ${pub} (info: a routed reader command has the container's network)`,
		);
		await exec(
			vm,
			"sudo -n docker rm -f vmsec-tb >/dev/null 2>&1; sudo -n rm -f /etc/sudoers.d/zz-vmsec-route /usr/local/bin/vmsec-route",
			60_000,
		);
	}

	const diagnostics = await exec(
		vm,
		[
			'echo "iptables: $(command -v iptables >/dev/null && echo present || echo missing), ip6tables: $(command -v ip6tables >/dev/null && echo present || echo missing)"',
			`echo "port 590x listeners: $(sudo -n ss -ltnpH 2>/dev/null | grep -E ':590[0-9][[:space:]]' | awk '{print $4}' | tr '\\n' ' ')"`,
			`echo "home $(stat -c %a ${sh(builderHome)}), desktop private $(stat -c %a ${DESKTOP_PRIVATE_DIRECTORY})"`,
		].join("\n"),
		60_000,
	);
	for (const line of diagnostics.stdout.trim().split("\n"))
		console.log(`Diagnostics (6): ${line}`);

	// ---- 8. memory token (M4) ------------------------------------------------------
	const lsRemote = async (token: string) => {
		try {
			await run("git", ["ls-remote", memoryRemote], {
				timeout: 30_000,
				env: {
					PATH: process.env.PATH,
					HOME: scratch,
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: `http.${memoryRemote}.extraHeader`,
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
				},
			});
			return "accepted";
		} catch {
			return "rejected";
		}
	};
	const tokenIssuedAt = Date.now();
	record(
		"8",
		"memory token works before release (control)",
		(await lsRemote(memoryToken)) === "accepted",
		"ls-remote with the VM's token",
	);
	const write = await exec(
		vm,
		`cd ${sh(`${builderHome}/memory`)} && printf '\\n- vm security proof line\\n' >> MEMORY.md && git -c core.hooksPath=/dev/null commit -qam 'vm security proof' && git -c core.hooksPath=/dev/null push -q origin main`,
		60_000,
	);
	record(
		"8",
		"memory write pushed from the VM (control)",
		write.exitCode === 0,
		`exit ${write.exitCode}`,
	);
	// releaseVm: scrub the clone, then revoke (the CLI has no revoke; see below).
	const scrub = await exec(vm, SCRUB_MEMORY_CREDENTIAL, 15_000);
	await repo.revokeCredential?.(memoryToken).catch(() => undefined);
	const configAfter = (await exec(vm, `cat ${sh(memoryConfig)}`, 15_000))
		.stdout;
	record(
		"8",
		"after release: token absent from ~/memory/.git/config",
		scrub.exitCode === 0 &&
			!configAfter.includes(memoryToken) &&
			!/extraheader/i.test(configAfter),
		`scrub exit ${scrub.exitCode}; token ${configAfter.includes(memoryToken) ? "PRESENT" : "absent"}`,
	);
	// A fresh fork after the turn (the writer-subagent fork, fork-vm.ts).
	try {
		const fork = await forkRunningVm({
			source: client.vms.ref(vm),
			sourceVmId: vm,
			boot: async (snapshotId) => {
				snapshots.add(snapshotId);
				return createChatVm(
					`ytimesy-vmsec-fork-${randomBytes(6).toString("hex")}`,
					snapshotId,
					"ytimesy-vm-security-proof",
				);
			},
			deleteSnapshot: async (snapshotId) => {
				await client.vms.snapshots.delete(snapshotId);
				snapshots.delete(snapshotId);
			},
			// As workspace-machines.ts forkWorkspace does.
			scrubFork: async (forkVm) => {
				const scrubbed = await exec(forkVm, SCRUB_MEMORY_CREDENTIAL, 30_000);
				if (scrubbed.exitCode !== 0)
					throw new Error("the memory clone still holds a token");
			},
			deleteVm: async (forkVm) => {
				await machines.destroy(WorkspaceId(forkVm));
				vms.delete(forkVm);
			},
		});
		const forkConfig = (
			await exec(
				fork.vmId,
				`cat ${sh(memoryConfig)} 2>/dev/null; grep -rl -- ${sh(memoryToken.slice(0, 24))} /tmp ${sh(builderHome)} 2>/dev/null | head -3`,
				60_000,
			)
		).stdout;
		record(
			"8",
			"fresh fork after release: token absent",
			!forkConfig.includes(memoryToken) &&
				!forkConfig.includes(memoryToken.slice(0, 24)),
			`token ${forkConfig.includes(memoryToken.slice(0, 24)) ? "PRESENT" : "absent"}`,
		);
		await machines.destroy(WorkspaceId(fork.vmId));
		vms.delete(fork.vmId);
		cleanup.push("fork VM deleted");
	} catch (error) {
		record(
			"8",
			"fresh fork after release",
			false,
			`could not run: ${safeError(error)}`,
		);
	}
	// A snapshot taken mid-turn (token present again, as on the next turn):
	// the product's snapshot path must scrub it.
	try {
		const second = await repo.credentials(MEMORY_TOKEN_TTL_SECONDS);
		const recloned = await exec(vm, memoryCloneScript(second), 90_000);
		const present = (
			await exec(vm, `cat ${sh(memoryConfig)}`, 15_000)
		).stdout.includes(second.token);
		const snapshotId = await machines.snapshotEnvironment(
			WorkspaceId(vm),
			`ytimesy-vmsec-${randomBytes(6).toString("hex")}`,
		);
		snapshots.add(snapshotId);
		const booted = await createChatVm(
			`ytimesy-vmsec-snap-${randomBytes(6).toString("hex")}`,
			snapshotId,
			"ytimesy-vm-security-proof",
		);
		const snapConfig = (
			await exec(
				booted,
				`cat ${sh(memoryConfig)} 2>/dev/null; grep -rl -- ${sh(second.token.slice(0, 24))} /tmp ${sh(builderHome)} 2>/dev/null | head -3`,
				60_000,
			)
		).stdout;
		record(
			"8",
			"snapshot taken mid-turn: token absent in a VM booted from it",
			recloned.exitCode === 0 &&
				present &&
				!snapConfig.includes(second.token.slice(0, 24)),
			`token before snapshot ${present ? "present" : "absent"}; in snapshot ${snapConfig.includes(second.token.slice(0, 24)) ? "PRESENT" : "absent"}`,
		);
		await machines.destroy(WorkspaceId(booted));
		vms.delete(booted);
		await machines.destroySnapshot(snapshotId as never);
		snapshots.delete(snapshotId);
		cleanup.push("snapshot and its VM deleted");
		await exec(vm, SCRUB_MEMORY_CREDENTIAL, 15_000);
	} catch (error) {
		record(
			"8",
			"snapshot mid-turn",
			false,
			`could not run: ${safeError(error)}`,
		);
	}

	// ---- 7. Git proxy grant (H1) ----------------------------------------------------
	const branch = `ytimesy/vmsec-${randomBytes(4).toString("hex")}`;
	const zero = "0".repeat(40);
	const someId = "1".repeat(40);
	const pkt = (text: string) =>
		`${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
	const commands = (lines: string[]) =>
		`${lines.map((line, index) => pkt(index === 0 ? `${line}\0report-status\n` : `${line}\n`)).join("")}0000`;
	// (a) The development edge: a project_repository row for the eval user's
	// project naming a repository that does not exist, so an allowed request
	// reaches authorization (the eval user has no GitHub connection: 503) and
	// a refused one stops before it (403). Nothing reaches GitHub.
	process.env.YTIMESY_GIT_PROXY_URL = DEVELOPMENT_EDGE_ORIGIN;
	const edgeConfig = gitProxyConfiguration();
	if (!edgeConfig) throw new Error("Git proxy configuration missing.");
	const fakeOwner = "ytimesy-vmsec-proof";
	const fakeName = `no-such-repo-${randomBytes(4).toString("hex")}`;
	await db.query(
		"insert into project_repository(project_id,repository_id,installation_id,full_name,branch,position) values($1,$2,1,$3,$4,99)",
		[
			user.project.projectId,
			9_100_000_000 + Math.floor(Math.random() * 1e8),
			`${fakeOwner}/${fakeName}`,
			branch,
		],
	);
	const edgeGrant = (access: "read" | "write") =>
		issueGitProxyGrant(edgeConfig.secret, {
			userId: user.userId,
			projectId: user.project.projectId,
			owner: fakeOwner,
			name: fakeName,
			installationId: 1,
			access,
			...(access === "write" ? { branch } : {}),
		});
	const receivePack = `${DEVELOPMENT_EDGE_ORIGIN}/git/${fakeOwner}/${fakeName}.git/git-receive-pack`;
	const edgePush = async (lines: string[], headers?: Record<string, string>) =>
		(
			await httpProbe(receivePack, {
				method: "POST",
				headers: {
					...(headers ?? (await edgeGrant("write"))),
					"content-type": "application/x-git-receive-pack-request",
				},
				body: commands(lines),
			})
		).status;
	const edgeCases: [
		string,
		() => Promise<number | null>,
		(status: number | null) => boolean,
	][] = [
		[
			"chat branch (control: passes to authorization)",
			() => edgePush([`${zero} ${someId} refs/heads/${branch}`]),
			(s) => s === 503,
		],
		[
			"another branch",
			() => edgePush([`${zero} ${someId} refs/heads/main`]),
			(s) => s === 403,
		],
		[
			"a tag",
			() => edgePush([`${zero} ${someId} refs/tags/vmsec`]),
			(s) => s === 403,
		],
		[
			"delete the chat branch",
			() => edgePush([`${someId} ${zero} refs/heads/${branch}`]),
			(s) => s === 403,
		],
		[
			"two refs at once",
			() =>
				edgePush([
					`${zero} ${someId} refs/heads/${branch}`,
					`${zero} ${someId} refs/heads/other`,
				]),
			(s) => s === 403,
		],
		[
			"unsigned grant",
			() =>
				edgePush([`${zero} ${someId} refs/heads/${branch}`], {
					"x-ytimesy-git-grant": "{}",
				}),
			(s) => s === 401,
		],
		[
			"read grant pushing",
			async () =>
				edgePush(
					[`${zero} ${someId} refs/heads/${branch}`],
					await edgeGrant("read"),
				),
			(s) => s === 403,
		],
	];
	for (const [label, send, ok] of edgeCases) {
		const status = await send();
		record(
			"7",
			`dev edge: ${label}`,
			ok(status),
			`HTTP ${status ?? "no response"}`,
		);
	}
	// (b) Push once and replay: the product's proxy, grant and claim (the
	// development database's git_proxy_grant_claim) and the product's push
	// client, in front of a local bare repository standing in for GitHub,
	// because no throwaway GitHub repository is known to be safe to push to.
	const gitRoot = join(scratch, "git");
	await run("bash", [
		"-c",
		`set -e; mkdir -p ${sh(gitRoot)}; git init -q --bare ${sh(`${gitRoot}/proof-repo.git`)}; git -C ${sh(`${gitRoot}/proof-repo.git`)} config http.receivepack true`,
	]);
	const backendPort = await listen(gitBackend(gitRoot));
	let receivePosts = 0;
	let _authorizeCalls = 0;
	await run(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
			"-keyout",
			join(scratch, "key.pem"),
			"-out",
			join(scratch, "cert.pem"),
		],
		{ timeout: 30_000 },
	);
	const proxyServer = createHttpsServer(
		{
			key: await readFile(join(scratch, "key.pem")),
			cert: await readFile(join(scratch, "cert.pem")),
		},
		(request, out) => {
			void proxyGithubGit(
				toRequest(request, "https://127.0.0.1"),
				mockSecret,
				async () => {
					_authorizeCalls++;
					return "mock-installation-token";
				},
				async (target, init) => {
					const path = new URL(String(target)).pathname.replace(
						/^\/[^/]+\//,
						"/",
					);
					if (path.endsWith("/git-receive-pack") && init?.method === "POST")
						receivePosts++;
					return fetch(
						`http://127.0.0.1:${backendPort}${path}${new URL(String(target)).search}`,
						init,
					);
				},
				async (nonce, expiresAt) => {
					claimedNonces.add(nonce);
					return claimGitProxyGrant(nonce, expiresAt);
				},
			).then((response) => sendResponse(response, out));
		},
	);
	const proxyPort = await listen(proxyServer as unknown as Server);
	process.env.YTIMESY_GIT_PROXY_URL = `https://127.0.0.1:${proxyPort}`;
	const mockConfig = gitProxyConfiguration();
	if (!mockConfig) throw new Error("Mock Git proxy configuration missing.");
	const mockSecret = mockConfig.secret;
	const work = join(scratch, "work");
	await run("bash", [
		"-c",
		`set -e; git init -q ${sh(work)}; cd ${sh(work)}; git -c user.name=p -c user.email=p@p.invalid commit -q --allow-empty -m one`,
	]);
	let capturedConfig = "";
	const hostEnv = {
		PATH: process.env.PATH,
		HOME: scratch,
		GIT_SSL_NO_VERIFY: "1",
	};
	const localHost = {
		async exec(command: string, timeout: number) {
			try {
				const output = await run("bash", ["-c", command], {
					timeout,
					env: hostEnv,
					maxBuffer: 1024 * 1024,
				});
				return { exitCode: 0, ...output };
			} catch (cause) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: String((cause as { stderr?: string }).stderr ?? ""),
				};
			}
		},
		async writeTextFile(path: string, contents: string) {
			if (path.endsWith("/config")) capturedConfig = contents;
			await writeFile(path, contents, { mode: 0o600 });
		},
	};
	const pushInput = {
		owner: "proof-owner",
		name: "proof-repo",
		branch,
		installationId: 1,
		userId: user.userId,
		projectId: user.project.projectId,
		directory: work,
	};
	let firstPush = "ok";
	await pushProxiedRepository(localHost as never, pushInput).catch((error) => {
		firstPush = safeError(error);
	});
	const landed = await run("git", [
		"--git-dir",
		`${gitRoot}/proof-repo.git`,
		"rev-parse",
		"--verify",
		`refs/heads/${branch}`,
	]).then(
		() => true,
		() => false,
	);
	record(
		"7",
		"mock: push to the chat branch (product push client + proxy + dev-DB claim)",
		firstPush === "ok" && landed,
		`push ${firstPush === "ok" ? "succeeded" : firstPush}; branch ${landed ? "landed" : "missing"}`,
	);
	const postsBefore = receivePosts;
	await run("bash", [
		"-c",
		`cd ${sh(work)} && git -c user.name=p -c user.email=p@p.invalid commit -q --allow-empty -m two`,
	]);
	const replayConfig = join(scratch, "replay.config");
	await writeFile(replayConfig, capturedConfig, { mode: 0o600 });
	const gitWith = async (configPath: string, args: string[]) =>
		run("git", ["-C", work, ...args], {
			timeout: 60_000,
			env: {
				...hostEnv,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: configPath,
				GIT_TERMINAL_PROMPT: "0",
			},
		}).then(
			() => "accepted",
			() => "refused",
		);
	const mockUrl = `https://127.0.0.1:${proxyPort}/git/proof-owner/proof-repo.git`;
	const replay = await gitWith(replayConfig, [
		"push",
		mockUrl,
		`HEAD:refs/heads/${branch}`,
	]);
	record(
		"7",
		"mock: replay the same grant",
		replay === "refused" && receivePosts === postsBefore,
		`${replay}; upstream receive-pack calls during replay ${receivePosts - postsBefore}`,
	);
	const freshConfig = async () => {
		const headers = await issueGitProxyGrant(mockSecret, {
			userId: user.userId,
			projectId: user.project.projectId,
			owner: "proof-owner",
			name: "proof-repo",
			installationId: 1,
			access: "write",
			branch,
		});
		const path = join(scratch, `grant-${randomUUID()}.config`);
		await writeFile(
			path,
			`[http ${JSON.stringify(`https://127.0.0.1:${proxyPort}/`)}]\n\tfollowRedirects = false\n${Object.entries(
				headers,
			)
				.map(
					([name, value]) =>
						`\textraHeader = ${JSON.stringify(`${name}: ${value}`)}`,
				)
				.join("\n")}\n`,
			{ mode: 0o600 },
		);
		return path;
	};
	for (const [label, args] of [
		["another branch", ["push", mockUrl, "HEAD:refs/heads/main"]],
		["a tag", ["push", mockUrl, "HEAD:refs/tags/vmsec"]],
		["delete the chat branch", ["push", mockUrl, `:refs/heads/${branch}`]],
	] as const) {
		const before = receivePosts;
		const outcome = await gitWith(await freshConfig(), [...args]);
		record(
			"7",
			`mock: fresh grant, ${label}`,
			outcome === "refused" && receivePosts === before,
			`${outcome}; upstream receive-pack calls ${receivePosts - before}`,
		);
	}
	const refs = (
		await run("git", [
			"--git-dir",
			`${gitRoot}/proof-repo.git`,
			"for-each-ref",
			"--format=%(refname)",
		])
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean);
	record(
		"7",
		"mock: upstream refs after all attempts",
		refs.length === 1 && refs[0] === `refs/heads/${branch}`,
		`${refs.length} ref(s): only the chat branch ${refs.length === 1 ? "yes" : "no"}`,
	);

	// ---- 2b. routes after the VM is deleted -------------------------------------
	await machines.publishHttpRoute?.(WorkspaceId(vm), {
		hostname: shareHost,
		port: PREVIEW_PORT,
	});
	const before = await pollProbe(
		`https://${shareHost}/`,
		{},
		(p) => p.status === 200 && p.body.includes(marker),
	);
	const rulesBefore = (await machines.listHttpRoutes?.(WorkspaceId(vm))) ?? [];
	await machines.destroy(WorkspaceId(vm));
	vms.delete(vm);
	cleanup.push("chat VM deleted");
	const afterDelete = await pollProbe(
		`https://${shareHost}/`,
		{},
		(p) => !p.body.includes(marker),
		120_000,
	);
	const deskAfter = await wsProbe(deskWs, {
		headers: { authorization: right },
	});
	record(
		"2",
		"after VM delete: old share and desktop hostnames",
		before.body.includes(marker) &&
			!afterDelete.body.includes(marker) &&
			afterDelete.status !== 200 &&
			deskAfter.status !== 101,
		`share before HTTP ${shown(before)} -> after HTTP ${shown(afterDelete)}; desktop handshake ${deskAfter.status ?? deskAfter.detail}`,
	);
	const rulesLeft = await client.tls.rules.list({ vmId: vm, limit: 100 }).then(
		(r) => r.rules.length,
		() => -1,
	);
	console.log(
		`Routes on the deleted VM: ${rulesBefore.length} before, ${rulesLeft} listed after.`,
	);
	if (rulesLeft > 0) {
		const { rules } = await client.tls.rules.list({ vmId: vm, limit: 100 });
		for (const rule of rules)
			await client.tls.rules
				.delete(rule.id)
				.catch(() => leftovers.push(`tls-rule:${rule.id}`));
		cleanup.push(`${rules.length} route(s) left by the deleted VM removed`);
	}

	// ---- 8 (cont). token expiry -----------------------------------------------------
	const wait =
		tokenIssuedAt + (MEMORY_TOKEN_TTL_SECONDS + 15) * 1000 - Date.now();
	if (wait > 0) await delay(wait);
	const expired = await lsRemote(memoryToken);
	record(
		"8",
		`released token after its TTL (${MEMORY_TOKEN_TTL_SECONDS}s here)`,
		expired === "rejected",
		`ls-remote ${expired}; explicit revocation not testable locally (Worker binding only)`,
	);

	// ---- 9. certificate transparency ------------------------------------------------
	const ct = async (query: string) => {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const response = await fetch(
					`https://crt.sh/?q=${encodeURIComponent(query)}&output=json`,
					{ signal: AbortSignal.timeout(90_000) },
				);
				if (response.ok)
					return (await response.json()) as { name_value: string }[];
			} catch {}
			await delay(5000);
		}
		return null;
	};
	const servedNames = await Promise.all(
		[...hostnames].map(
			(host) =>
				new Promise<string>((resolve) => {
					const socket = tlsConnect(
						{ host, port: 443, servername: host, timeout: 15_000 },
						() => {
							const san = socket.getPeerCertificate().subjectaltname ?? "";
							socket.end();
							resolve(
								san.includes(`DNS:${host}`)
									? "per-host"
									: san.includes("DNS:*.style.dev")
										? "wildcard"
										: "other",
							);
						},
					);
					socket.on("error", () => resolve("unreachable"));
					socket.on("timeout", () => {
						socket.destroy();
						resolve("timeout");
					});
				}),
		),
	);
	const servedCounts = servedNames.reduce<Record<string, number>>(
		(all, kind) => {
			all[kind] = (all[kind] ?? 0) + 1;
			return all;
		},
		{},
	);
	record(
		"9",
		"certificate served for this run's hostnames",
		servedNames.every(
			(kind) =>
				kind === "wildcard" || kind === "unreachable" || kind === "timeout",
		)
			? true
			: !servedNames.includes("per-host"),
		Object.entries(servedCounts)
			.map(([kind, n]) => `${kind}: ${n}`)
			.join(", "),
	);
	const spotter = await Promise.all(
		[...hostnames].map(async (host) => {
			try {
				const response = await fetch(
					`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(host)}&expand=dns_names`,
					{ signal: AbortSignal.timeout(30_000) },
				);
				return response.ok
					? ((await response.json()) as unknown[]).length
					: null;
			} catch {
				return null;
			}
		}),
	);
	record(
		"9",
		"Cert Spotter: this run's exact hostnames in CT",
		spotter.some((n) => n === null) ? null : spotter.every((n) => n === 0),
		`${spotter.filter((n) => n !== null).length}/${spotter.length} queried, ${spotter.reduce<number>((sum, n) => sum + (n ?? 0), 0)} issuance(s) found`,
	);
	const pattern = await ct("ytimesy-%.style.dev");
	const exact = await Promise.all([...hostnames].map((name) => ct(name)));
	const names = new Set(
		(pattern ?? [])
			.flatMap((entry) => entry.name_value.split("\n"))
			.filter((name) => name.startsWith("ytimesy-")),
	);
	const kinds = new Map<string, number>();
	for (const name of names) {
		const kind = /^ytimesy-([a-z]+)-/.exec(name)?.[1] ?? "other";
		kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
	}
	const wildcard = await ct("%.style.dev");
	const wildcards = new Set(
		(wildcard ?? [])
			.flatMap((entry) => entry.name_value.split("\n"))
			.filter((name) => name.startsWith("*.")),
	).size;
	record(
		"9",
		"crt.sh: per-VM ytimesy-*.style.dev names published",
		pattern === null ? null : names.size === 0,
		pattern === null
			? "crt.sh unavailable"
			: `${names.size} distinct name(s)${names.size ? ` (${[...kinds].map(([k, n]) => `${k}:${n}`).join(", ")})` : ""}; this run's ${hostnames.size} names: ${exact.filter((e) => e?.length).length} logged so far; wildcard style.dev certs seen: ${wildcard === null ? "unknown" : wildcards}`,
	);
} catch (error) {
	record("-", "proof aborted", false, safeError(error));
} finally {
	// ---- cleanup ----------------------------------------------------------------------
	(tunnel as ChildProcess | null)?.kill("SIGTERM");
	if (tunnel) cleanup.push("quick tunnel stopped");
	for (const server of localServers) server.close();
	for (const id of vms) {
		const routes = await machines
			.withdrawHttpRoutes?.(WorkspaceId(id), ["desk", "tools", "pv", "share"])
			.catch(() => -1);
		if (routes === -1) leftovers.push(`routes:${id}`);
		await machines.destroy(WorkspaceId(id)).then(
			() => cleanup.push(`VM deleted (${routes} route(s) withdrawn)`),
			() => leftovers.push(`vm:${id}`),
		);
	}
	for (const id of snapshots)
		await machines.destroySnapshot(id as never).then(
			() => cleanup.push("snapshot deleted"),
			() => leftovers.push(`snapshot:${id}`),
		);
	for (const id of forwardAuthIds)
		await client.tls.forwardAuth.delete(id).then(
			() => cleanup.push("forward-auth config deleted"),
			() => leftovers.push(`forward-auth:${id}`),
		);
	if (claimedNonces.size)
		await database()
			.query("delete from git_proxy_grant_claim where nonce = any($1)", [
				[...claimedNonces],
			])
			.then(
				(r) => cleanup.push(`${r.rowCount} Git grant claim row(s) deleted`),
				() => leftovers.push("git_proxy_grant_claim rows"),
			);
	const released = await user.release().catch((error) => [safeError(error)]);
	if (released.length) leftovers.push(...released);
	else
		cleanup.push(
			"eval user, chat, project copy, memory repo and VM records deleted",
		);
	await rm(scratch, { recursive: true, force: true });
	await closeDatabase().catch(() => undefined);

	console.log("\n| # | Check | Result | Evidence |\n|---|---|---|---|");
	for (const r of results)
		console.log(
			`| ${r.item} | ${r.check} | ${r.pass === null ? "SKIP" : r.pass ? "PASS" : "FAIL"} | ${r.evidence.replaceAll("|", "/")} |`,
		);
	console.log(`\nCleanup: ${cleanup.join("; ")}.`);
	console.log(
		leftovers.length
			? `LEFTOVERS: ${leftovers.join(", ")}`
			: "Leftovers: none.",
	);
	process.exitCode = results.some((r) => r.pass === false) ? 1 : 0;
}
