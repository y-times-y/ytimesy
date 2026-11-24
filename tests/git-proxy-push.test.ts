import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { posixShellQuoted as quote } from "../src/domain/posix-command";
import { pushProxiedRepository } from "../src/server/adapters/github/git-proxy-transfer";
import {
	MANAGED_GIT_BOT,
	MANAGED_GIT_TRAILER,
} from "../src/server/adapters/managed-git-identity";
import { claimGitProxyGrant } from "../src/server/edge/github-git-authorization";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => db.query(sql, params),
	}),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

it("spends a push grant once and sweeps long-expired ones", async () => {
	const nonce = "a".repeat(32);
	const expiresAt = Date.now() + 60_000;
	expect(await claimGitProxyGrant(nonce, expiresAt)).toBe(true);
	expect(await claimGitProxyGrant(nonce, expiresAt)).toBe(false);
	expect(await claimGitProxyGrant("not-a-nonce", expiresAt)).toBe(false);
	await db.query(
		"insert into git_proxy_grant_claim values ($1, now() - interval '1 hour')",
		["b".repeat(32)],
	);
	expect(await claimGitProxyGrant("c".repeat(32), expiresAt)).toBe(true);
	expect(
		(
			await db.query("select 1 from git_proxy_grant_claim where nonce = $1", [
				"b".repeat(32),
			])
		).rows,
	).toHaveLength(0);
});

it("pushes from a fresh repository that ignores the checkout's own Git config", async () => {
	vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://proxy.invalid");
	vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", "f".repeat(64));
	const root = mkdtempSync(join(tmpdir(), "ytimesy-proxy-push-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, { encoding: "utf8" }).trim();
	const remote = join(root, "remote.git");
	const evil = join(root, "evil.git");
	const checkout = join(root, "checkout");
	git("init", "-q", "--bare", remote);
	git("init", "-q", "--bare", evil);
	git("init", "-q", checkout);
	writeFileSync(join(checkout, "a.txt"), "a\n");
	git("-C", checkout, "add", "a.txt");
	git(
		"-C",
		checkout,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.test",
		"commit",
		"-qm",
		"a",
	);
	git("-C", checkout, "push", "-q", remote, "HEAD:refs/heads/main");
	git("-C", checkout, "config", "user.name", MANAGED_GIT_BOT.name);
	git("-C", checkout, "config", "user.email", MANAGED_GIT_BOT.email);
	git("-C", checkout, "commit", "--allow-empty", "-qm", "Missing trailer");
	// The agent owns this config; a push that read it would land in `evil`.
	git("-C", checkout, "config", `url.${evil}.insteadOf`, remote);
	git("-C", checkout, "config", `url.${evil}.pushInsteadOf`, remote);
	let temporary = "";
	const host = {
		exec: vi.fn(async (command: string) => {
			// Stand in for the proxy origin with a local bare repository.
			const local = command
				.replaceAll(
					"GIT_ALLOW_PROTOCOL=https ",
					"GIT_ALLOW_PROTOCOL=https:file ",
				)
				.replaceAll(
					quote("https://proxy.invalid/git/fixture/repository.git"),
					quote(remote),
				);
			const result = spawnSync("sh", ["-c", local], { encoding: "utf8" });
			if (command.includes("mktemp")) temporary = result.stdout.trim();
			return {
				exitCode: result.status ?? 1,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		}),
		writeTextFile: vi.fn(async (path: string, contents: string) =>
			writeFileSync(path, contents),
		),
	};
	const publication = {
		userId: "user-1",
		projectId: "00000000-0000-4000-8000-000000000002",
		owner: "fixture",
		name: "repository",
		branch: "ytimesy/chat",
		installationId: 1,
		directory: checkout,
	};
	const before = git("-C", checkout, "rev-parse", "HEAD");
	await expect(pushProxiedRepository(host, publication)).rejects.toThrow(
		/Co-authored-by trailer/,
	);
	expect(git("-C", checkout, "rev-parse", "HEAD")).toBe(before);
	expect(git("--git-dir", remote, "branch", "--list", "ytimesy/chat")).toBe("");
	git("-C", checkout, "checkout", "-qb", "compliant", "HEAD^");
	git(
		"-C",
		checkout,
		"commit",
		"--allow-empty",
		"-qm",
		"Compliant commit",
		"--trailer",
		MANAGED_GIT_TRAILER,
	);
	host.exec.mockClear();
	host.writeTextFile.mockClear();
	await pushProxiedRepository(host, publication);
	expect(git("--git-dir", remote, "rev-parse", "refs/heads/ytimesy/chat")).toBe(
		git("-C", checkout, "rev-parse", "HEAD"),
	);
	expect(git("--git-dir", evil, "for-each-ref")).toBe("");
	const config = host.writeTextFile.mock.calls[0][1];
	expect(config).toContain("x-ytimesy-git-grant");
	expect(
		JSON.parse(
			JSON.parse(
				config.match(/extraHeader = (".*x-ytimesy-git-grant.*")/)?.[1] ?? "",
			).replace(/^x-ytimesy-git-grant: /, ""),
		),
	).toMatchObject({ access: "write", branch: "ytimesy/chat" });
	expect(temporary).toMatch(/^\/tmp\/ytimesy-git-proxy-/);
	expect(existsSync(temporary)).toBe(false);
	// Three guest round trips: name and directory, the config file, the push.
	expect(host.exec).toHaveBeenCalledTimes(2);
	expect(host.writeTextFile).toHaveBeenCalledTimes(1);
});
