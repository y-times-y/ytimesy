#!/usr/bin/env node
// Prints the proposed v0.x.y tag plan. Read-only: never creates, pushes or publishes a tag.
// Rules (docs/versioning.md): each milestone below is the next patch version, v0.0.1, v0.0.2, ...
// A minor bump is an explicit owner decision, so none are planned here.

import { execFileSync } from "node:child_process";

// Commit prefixes are the current main hashes (history was rewritten on 2026-11-24).
const milestones = [
	["5aaa0308", "Sign-in, GitHub onboarding, Freestyle cloud VMs, first agent chat (Codex)"],
	["d1e4be08", "Pull requests from the app, Claude and OpenCode harnesses, parallel chats"],
	["ca092a27", "Multi-provider API models, reusable environments, Codex subscription on the shared harness"],
	["8fd1f0bc", "Cloudflare runtime (workflows, Workers, Durable Objects), evals, plugins and MCP, production deploy tooling"],
	["565f325c", "Subagents and memory"],
	["e36d7fd5", "SuperGrok and Claude Code subscription routes, CLI and session import"],
	["0162b378", "AWS runner boxes for Codex proxy and Claude Code"],
	["bea64766", "Canvas"],
	["a2ba013b", "Y² super agent"],
	["1bf700bf", "Public repository, MIT licence, CI"],
	["2368be61", "Y² thread messaging"],
];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

milestones.forEach(([rev, title], i) => {
	const date = git("show", "-s", "--format=%cs", rev);
	console.log(`v0.0.${i + 1}\t${date}\t${rev}\t${title}`);
});
console.log(`\ncommits on main: ${git("rev-list", "--count", "HEAD")}; current estimate: v0.0.${milestones.length}+`);
