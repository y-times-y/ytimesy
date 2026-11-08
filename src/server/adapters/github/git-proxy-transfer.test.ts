import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { receiveProxiedRepository } from "./git-proxy-transfer";

const run = promisify(execFile);
const ORIGIN = "https://proxy.example.test";
let root: string;
let source: string;

beforeEach(async () => {
	vi.stubEnv("YTIMESY_GIT_PROXY_URL", `${ORIGIN}/`);
	vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", "p".repeat(48));
	root = await mkdtemp(join(tmpdir(), "ytimesy-proxy-clone-"));
	source = join(root, "source");
	const git = (...args: string[]) => run("git", ["-C", source, ...args]);
	await run("git", ["init", "-q", "-b", "main", source]);
	await git("config", "user.email", "t@example.test");
	await git("config", "user.name", "t");
	await git("commit", "-q", "--allow-empty", "-m", "first");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/**
 * A guest that is this machine: the proxy URL is served by a local
 * repository (file protocol allowed only here), everything else runs as sent.
 */
function localGuest() {
	const calls: { command: string; env: Record<string, string> }[] = [];
	const shell = async (command: string, env: Record<string, string> = {}) => {
		try {
			const { stdout, stderr } = await run("bash", ["-c", command], {
				env: { PATH: process.env.PATH, HOME: root, ...env },
			});
			return { exitCode: 0, stdout, stderr };
		} catch (error) {
			const failed = error as {
				code?: number;
				stdout?: string;
				stderr?: string;
			};
			return {
				exitCode: failed.code ?? 1,
				stdout: failed.stdout ?? "",
				stderr: failed.stderr ?? "",
			};
		}
	};
	return {
		calls,
		host: {
			exec: async (command: string) => {
				calls.push({ command, env: {} });
				return shell(command);
			},
			writeTextFile: async () => {
				throw new Error("The one-command clone writes nothing separately.");
			},
			execWithEnv: async (
				command: string,
				env: Record<string, string>,
				_timeoutMs: number,
			) => {
				calls.push({ command, env });
				return shell(
					command
						.replace(
							"GIT_ALLOW_PROTOCOL=https ",
							"GIT_ALLOW_PROTOCOL=https:file ",
						)
						.replace(`'${ORIGIN}/git/acme/app.git'`, `'${source}'`),
					env,
				);
			},
		},
	};
}

const repository = {
	userId: "u1",
	projectId: "00000000-0000-4000-8000-000000000001",
	owner: "acme",
	name: "app",
	branch: "main",
	installationId: 7,
};

it("clones in one guest command whose text carries no grant, and removes its private config", async () => {
	const guest = localGuest();
	const destination = join(root, "checkout");
	const temporaries = async () =>
		(await readdir("/tmp")).filter((name) =>
			name.startsWith("ytimesy-git-proxy-"),
		);
	const before = await temporaries();
	await expect(
		receiveProxiedRepository(guest.host, {
			...repository,
			destination,
			mode: "clone",
		}),
	).resolves.toBe("updated");
	expect(guest.calls).toHaveLength(1);
	const [call] = guest.calls;
	expect(call.env.YTIMESY_GIT_PROXY_CONFIG).toContain("x-ytimesy-git-grant");
	expect(call.command).not.toContain("x-ytimesy-git-grant");
	expect(call.command).not.toContain("x-ytimesy-delivery-signature");
	const head = await run("git", [
		"-C",
		destination,
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	]);
	expect(head.stdout.trim()).toBe("main");
	const origin = await run("git", [
		"-C",
		destination,
		"remote",
		"get-url",
		"origin",
	]);
	expect(origin.stdout.trim()).toBe("https://github.com/acme/app.git");
	expect(await temporaries()).toEqual(before);
	expect(
		await readFile(join(destination, ".git/config"), "utf8"),
	).not.toContain("extraHeader");
});

it("says which step of the one-command clone failed", async () => {
	const guest = localGuest();
	await expect(
		receiveProxiedRepository(guest.host, {
			...repository,
			branch: "bad..name",
			destination: join(root, "a"),
			mode: "clone",
		}),
	).rejects.toThrow("Workspace Git rejected the branch name.");
	await expect(
		receiveProxiedRepository(guest.host, {
			...repository,
			branch: "missing",
			destination: join(root, "b"),
			mode: "clone",
		}),
	).rejects.toThrow(
		"Workspace Git proxy transfer failed; check repository access.",
	);
	await expect(
		receiveProxiedRepository(guest.host, {
			...repository,
			destination: join(root, "source"),
			mode: "clone",
		}),
	).rejects.toThrow("Workspace Git could not create the checkout.");
});

it("fast-forwards a clean checkout in one guest command, and leaves a dirty one alone", async () => {
	const guest = localGuest();
	const destination = join(root, "checkout");
	await receiveProxiedRepository(guest.host, {
		...repository,
		destination,
		mode: "clone",
	});
	await run("git", [
		"-C",
		source,
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"second",
	]);
	const moved = (
		await run("git", ["-C", source, "rev-parse", "HEAD"])
	).stdout.trim();
	guest.calls.length = 0;
	await expect(
		receiveProxiedRepository(guest.host, {
			...repository,
			destination,
			mode: "update",
		}),
	).resolves.toBe("updated");
	expect(guest.calls).toHaveLength(1);
	expect(
		(await run("git", ["-C", destination, "rev-parse", "HEAD"])).stdout.trim(),
	).toBe(moved);
	await run("bash", [
		"-c",
		`echo change > ${JSON.stringify(join(destination, "file.txt"))}`,
	]);
	await expect(
		receiveProxiedRepository(guest.host, {
			...repository,
			destination,
			mode: "update",
		}),
	).resolves.toBe("dirty");
});

function hostWhoseStatusTimesOut(timeouts: number) {
	const budgets: number[] = [];
	let remaining = timeouts;
	return {
		budgets,
		host: {
			writeTextFile: async () => {},
			exec: async (command: string, budgetMs = 0) => {
				if (!command.includes("status --porcelain"))
					return { exitCode: 0, stdout: "", stderr: "" };
				budgets.push(budgetMs ?? 0);
				if (remaining-- > 0) return { exitCode: 124, stdout: "", stderr: "" };
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
	};
}

it("repeats a checkout status that timed out, with a larger budget each time", async () => {
	const { host, budgets } = hostWhoseStatusTimesOut(2);
	await receiveProxiedRepository(host, {
		...repository,
		destination: "/home/user/r",
		mode: "switch",
	}).catch(() => undefined);
	expect(budgets.slice(0, 3)).toEqual([30_000, 60_000, 120_000]);
});

it("fails with the status message only when every attempt timed out", async () => {
	const { host, budgets } = hostWhoseStatusTimesOut(3);
	await expect(
		receiveProxiedRepository(host, {
			...repository,
			destination: "/home/user/r",
			mode: "switch",
		}),
	).rejects.toThrow("Workspace Git could not read the checkout's status.");
	expect(budgets).toEqual([30_000, 60_000, 120_000]);
});

it("does not repeat a status that failed for another reason", async () => {
	const budgets: number[] = [];
	const host = {
		writeTextFile: async () => {},
		exec: async (command: string, budgetMs = 0) => {
			if (command.includes("status --porcelain")) budgets.push(budgetMs ?? 0);
			return command.includes("status --porcelain")
				? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }
				: { exitCode: 0, stdout: "", stderr: "" };
		},
	};
	await expect(
		receiveProxiedRepository(host, {
			...repository,
			destination: "/home/user/r",
			mode: "switch",
		}),
	).rejects.toThrow("could not read the checkout's status");
	expect(budgets).toEqual([30_000]);
});
