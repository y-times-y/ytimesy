import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	repository: "",
	commands: [] as { args: string[]; env: NodeJS.ProcessEnv }[],
}));
vi.mock("./installation-token", () => ({
	githubInstallationAccessToken: async () => "broker-token-fixture",
}));
vi.mock("node:child_process", async (load) => {
	const actual = await load<typeof import("node:child_process")>();
	const wrapped = (...parameters: unknown[]) => {
		const [file, args, ...rest] = parameters;
		if (file === "git") {
			const options = rest[0] as { env?: NodeJS.ProcessEnv };
			transport.commands.push({
				args: args as string[],
				env: options?.env ?? {},
			});
		}
		const rewritten = (args as string[]).map((arg) =>
			arg === "https://github.com/acme/app.git" ? transport.repository : arg,
		);
		return (actual.execFile as (...args: unknown[]) => unknown)(
			file,
			rewritten,
			...rest,
		);
	};
	const util = await import("node:util");
	Object.defineProperty(wrapped, util.promisify.custom, {
		value: async (...parameters: unknown[]) =>
			new Promise((resolve, reject) =>
				wrapped(
					...parameters,
					(error: Error | null, stdout: string, stderr: string) =>
						error ? reject(error) : resolve({ stdout, stderr }),
				),
			),
	});
	return { ...actual, execFile: wrapped };
});

import { execFile } from "node:child_process";
import {
	pushBrokeredRepository,
	receiveBrokeredRepository,
} from "./git-broker";

const execute = promisify(execFile);
beforeEach(() => {
	vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
	transport.commands = [];
	vi.unstubAllEnvs();
});

it("clones and pushes Git bundles while no guest command, file or remote contains a credential", async () => {
	const temp = await mkdtemp(join(tmpdir(), "git-broker-test-"));
	try {
		const source = join(temp, "source");
		const guest = join(temp, "guest");
		await mkdir(source);
		transport.repository = source;
		const git = (...args: string[]) => execute("git", ["-C", source, ...args]);
		await git("init", "-b", "main");
		await writeFile(join(source, "file"), "base");
		await git("add", ".");
		await git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"base",
		);
		await git("config", "receive.denyCurrentBranch", "ignore");
		const guestCommands: string[] = [];
		const guestFiles: string[] = [];
		const host = {
			exec: async (command: string) => {
				guestCommands.push(command);
				try {
					const r = await execute("bash", ["-c", command]);
					return { ...r, exitCode: 0 };
				} catch {
					return { exitCode: 1, stdout: "", stderr: "failed" };
				}
			},
			writeTextFile: async (path: string, text: string) => {
				guestFiles.push(text);
				await writeFile(path, text);
			},
			readTextFile: (path: string) => readFile(path, "utf8"),
		};
		expect(
			await receiveBrokeredRepository(host, {
				owner: "acme",
				name: "app",
				branch: "main",
				installationId: 1,
				destination: guest,
				mode: "clone",
			}),
		).toBe("updated");
		// The checkout keeps the VM's umask (only the bundle is 0600), so a
		// read-only helper running as another Linux user can read it.
		expect((await stat(join(guest, "file"))).mode & 0o777).toBe(
			0o666 & ~process.umask(),
		);
		await writeFile(join(guest, "file"), "changed");
		await execute("git", ["-C", guest, "add", "."]);
		await execute("git", [
			"-C",
			guest,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"changed",
		]);
		const publish = {
			owner: "acme",
			name: "app",
			branch: "feature",
			installationId: 1,
			directory: guest,
		};
		await expect(pushBrokeredRepository(host, publish)).rejects.toThrow(
			/managed Git identity/,
		);
		const bot =
			"ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>";
		const amend = [
			"-C",
			guest,
			"commit",
			"--amend",
			"--no-edit",
			`--author=${bot}`,
		];
		const env = {
			...process.env,
			GIT_COMMITTER_NAME: "Override",
			GIT_COMMITTER_EMAIL: "wrong@example.test",
		};
		await execute("git", amend, { env });
		await expect(pushBrokeredRepository(host, publish)).rejects.toThrow(
			/managed Git identity/,
		);
		const botCommitter = {
			env: {
				...env,
				GIT_COMMITTER_NAME: "ytimesy-agent[bot]",
				GIT_COMMITTER_EMAIL:
					"328807657+ytimesy-agent[bot]@users.noreply.github.com",
			},
		};
		await execute("git", amend, botCommitter);
		const readHead = () => execute("git", ["-C", guest, "rev-parse", "HEAD"]);
		const before = (await readHead()).stdout;
		await expect(pushBrokeredRepository(host, publish)).rejects.toThrow(
			/Co-authored-by trailer/,
		);
		expect((await readHead()).stdout).toBe(before);
		expect((await git("branch", "--list", "feature")).stdout).toBe("");
		await execute(
			"git",
			[...amend, "--trailer", `Co-authored-by: ${bot}`],
			botCommitter,
		);
		await pushBrokeredRepository(host, publish);
		expect((await git("show", "feature:file")).stdout).toBe("changed");
		const revision = `refs/ytimesy/turn-commits/${"a".repeat(64)}`;
		await execute("git", ["-C", guest, "update-ref", revision, "HEAD"]);
		await writeFile(join(guest, "file"), "later turn");
		await execute("git", ["-C", guest, "add", "."]);
		await execute("git", [
			"-C",
			guest,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"later",
		]);
		await pushBrokeredRepository(host, {
			owner: "acme",
			name: "app",
			branch: "completed-turn",
			installationId: 1,
			directory: guest,
			revision,
		});
		expect((await git("show", "completed-turn:file")).stdout).toBe("changed");
		const shallow = join(temp, "shallow");
		await execute("git", ["clone", "--depth=1", `file://${source}`, shallow]);
		await pushBrokeredRepository(
			{ ...host },
			{
				owner: "acme",
				name: "app",
				branch: "shallow-publication",
				baseBranch: "main",
				installationId: 1,
				directory: shallow,
			},
		);
		expect((await git("show", "shallow-publication:file")).stdout).toBe("base");
		expect(JSON.stringify([guestCommands, guestFiles])).not.toContain(
			"broker-token-fixture",
		);
		expect(
			(
				await execute("git", ["-C", guest, "remote", "get-url", "origin"])
			).stdout.trim(),
		).toBe("https://github.com/acme/app.git");
		const authenticated = transport.commands.filter(
			({ env }) => env.GIT_CONFIG_VALUE_0,
		);
		expect(
			authenticated.filter(({ args }) => args.includes("push")),
		).toHaveLength(3);
		for (const command of authenticated) {
			expect(JSON.stringify(command.args)).not.toContain(
				"broker-token-fixture",
			);
			expect(command.env.DATABASE_URL).toBeUndefined();
			expect(command.env.GITHUB_PRIVATE_KEY).toBeUndefined();
		}
		await writeFile(join(guest, "file"), "uncommitted");
		expect(
			await receiveBrokeredRepository(host, {
				owner: "acme",
				name: "app",
				branch: "main",
				installationId: 1,
				destination: guest,
				mode: "update",
			}),
		).toBe("dirty");
		expect(await readFile(join(guest, "file"), "utf8")).toBe("uncommitted");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 30_000); // Real git clone/push of bundles; slow under a loaded full-suite run.
