#!/usr/bin/env node
// Prints the proposed v0.x.y tag plan. Read-only: never creates, pushes or publishes a tag.
// Rules (docs/versioning.md): each milestone below is a minor bump; after a minor, each
// later Monday that has at least PATCH_MIN_COMMITS new commits since the last tag gets a patch.
import { execFileSync } from "node:child_process";

const PATCH_MIN_COMMITS = 40;

// Commit prefixes are the current main hashes (history was rewritten on 2026-11-24).
const milestones = [
	["5aaa0308", "GitHub sign-in and project onboarding"],
	["917317b0", "Freestyle cloud VMs and Codex device login"],
	["d1e4be08", "Pull requests from the app"],
	["48ecdaa5", "Claude and OpenCode harnesses, parallel chats"],
	["ca092a27", "Multi-provider API models, reusable environments"],
	["16c05b18", "Codex subscription on the durable shared harness, cloud handoff"],
	["8fd1f0bc", "Cloudflare execution workflows, Terminal-Bench evals"],
	["09ca46be", "Plugins and remote MCP servers"],
	["fa037d25", "Web app on Cloudflare Workers, Durable Object chats"],
	["b10b7d05", "Guarded production deploy"],
	["565f325c", "Subagents (agent, agent_send)"],
	["abd0f088", "Memory"],
	["e36d7fd5", "SuperGrok and Claude Code subscription routes"],
	["a23f3372", "ytimesy CLI and session import"],
	["0162b378", "AWS runner boxes for Codex proxy and Claude Code"],
	["bea64766", "Canvas"],
	["a2ba013b", "Y² super agent"],
	["1bf700bf", "Public repository, MIT licence, CI"],
	["2368be61", "Y² thread messaging"],
];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const dateOf = (rev) => git("show", "-s", "--format=%cs", rev);
const monday = (iso) => {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
};

const all = git("log", "--reverse", "--format=%H %cs").split("\n").map((l) => l.split(" "));
const indexOf = (rev) => {
	const full = git("rev-parse", rev);
	return all.findIndex(([h]) => h === full);
};
const rows = [];
milestones.forEach(([rev, title], i) => {
	const start = indexOf(rev);
	const end = i + 1 < milestones.length ? indexOf(milestones[i + 1][0]) : all.length;
	rows.push({ tag: `v0.${i + 1}.0`, rev, date: dateOf(rev), title });
	let patch = 0;
	let last = start;
	let lastMonday = monday(all[start][1]);
	for (let n = start + 1; n < end; n++) {
		const m = monday(all[n][1]);
		if (m !== lastMonday) {
			if (n - last >= PATCH_MIN_COMMITS) {
				patch += 1;
				rows.push({ tag: `v0.${i + 1}.${patch}`, rev: all[n - 1][0].slice(0, 8), date: all[n - 1][1], title: "weekly patch" });
				last = n;
			}
			lastMonday = m;
		}
	}
});
for (const r of rows) console.log(`${r.tag}\t${r.date}\t${r.rev}\t${r.title}`);
const tip = all.length;
console.log(`\ncommits on main: ${tip}; tags: ${rows.length}; current estimate: ${rows.at(-1).tag}+ (tip ${all.at(-1)[1]})`);
