import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { parsePlugin } from "#/domain/plugin-package";
import { fetchPinnedPlugin } from "./plugin-source";

const sha = "0123456789abcdef0123456789abcdef01234567";

async function githubTarball(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-plugin-"));
	const top = `acme-tools-${sha.slice(0, 7)}`;
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, top, path)), { recursive: true });
		await writeFile(join(root, top, path), text);
	}
	execFileSync("tar", ["-czf", join(root, "archive.tgz"), "-C", root, top]);
	const bytes = await readFile(join(root, "archive.tgz"));
	await rm(root, { recursive: true, force: true });
	return bytes;
}

it("downloads a pinned commit, keeps only the plugin folder, and parses it", async () => {
	const longSkill = `${"a".repeat(60)}-${"b".repeat(40)}`;
	const archive = await githubTarball({
		"README.md": "repo readme, outside the plugin",
		"plugins/linear/.claude-plugin/plugin.json": JSON.stringify({
			name: "linear",
		}),
		"plugins/linear/commands/standup.md": "Summarize my issues.",
		[`plugins/linear/skills/${longSkill}/SKILL.md`]: `---\nname: triage\n---\nTriage issues.`,
		"plugins/linear/.mcp.json": JSON.stringify({
			mcpServers: {
				linear: { type: "http", url: "https://mcp.linear.app/mcp" },
			},
		}),
		"plugins/linear/bin/tool": "binary-ish",
	});
	const requested: string[] = [];
	const files = await fetchPinnedPlugin(
		{ owner: "acme", repo: "tools", sha, path: "plugins/linear" },
		async (input) => {
			requested.push(String(input));
			return new Response(archive);
		},
	);
	expect(requested).toEqual([
		`https://codeload.github.com/acme/tools/tar.gz/${sha}`,
	]);
	expect(files.has("README.md")).toBe(false);
	expect(files.get("bin/tool")).toBe("");
	const plugin = parsePlugin(files, "linear");
	expect(plugin.commands.map((command) => command.name)).toEqual(["standup"]);
	expect(plugin.skills.map((skill) => skill.name)).toEqual(["triage"]);
	expect(plugin.mcpServers.map((server) => server.url)).toEqual([
		"https://mcp.linear.app/mcp",
	]);
	expect(plugin.unsupported).toContain("executables (bin/)");
});

it("refuses unpinned refs and odd repository names before any request", async () => {
	const never = async () => {
		throw new Error("should not fetch");
	};
	for (const source of [
		{ owner: "acme", repo: "tools", sha: "main", path: "" },
		{ owner: "acme/../x", repo: "tools", sha, path: "" },
	])
		await expect(fetchPinnedPlugin(source, never)).rejects.toThrow("pinned");
});
