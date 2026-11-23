// Offline proof that a read-only helper (ytimesy-reader) can read the
// builder's checkout and nothing private, in a rehearsal VM (a privileged
// ubuntu container, scripts/rehearsal/vm.ts). The checkout is written the
// way the edge executor's streamed setup writes it (a detached command,
// src/server/adapters/freestyle/detached-command.ts), then once more under
// umask 077, as on VMs checked out before that was fixed. Each layout runs
// with setfacl (the ACL grant) and without it (the mode fallback).
//
//   node --import tsx scripts/rehearsal/prove-reader-checkout.ts
//
// Prints PASS/FAIL per check; exits non-zero on any failure. The container
// is removed at the end.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { WorkspaceId } from "../../src/domain/ids";
import { runDetachedCommand } from "../../src/server/adapters/freestyle/detached-command";
import {
	forgetPreparedReaders,
	readerWorkspaceMachines,
} from "../../src/server/services/reader-workspace-machines";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";
import { ensureVmImage, VM_IMAGE } from "./vm";

const name = `ytimesy-reader-proof-${randomBytes(4).toString("hex")}`;
const HOME = "/home/ubuntu";
const CHECKOUT = `${HOME}/ytimesy`;

const sh = (user: string, command: string) => {
	const r = spawnSync(
		"docker",
		["exec", "-u", user, "-w", HOME, name, "bash", "-c", command],
		{ encoding: "utf8" },
	);
	return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

const base = {
	exec: async (_vm: unknown, command: string) => sh("ubuntu", command),
	readTextFile: async (_vm: unknown, path: string) => {
		const r = sh("ubuntu", `cat ${path}`);
		return r.exitCode ? null : r.stdout;
	},
	writeTextFile: async () => {},
} as unknown as WorkspaceMachines;

/** [label, reader command, should succeed] */
const CHECKS: [string, string, boolean][] = [
	["reads package.json", `cat ${CHECKOUT}/package.json`, true],
	["reads a skill", `cat ${CHECKOUT}/.agents/skills/x/SKILL.md`, true],
	["lists the checkout", `ls ${CHECKOUT}`, true],
	["runs git log", `git -C ${CHECKOUT} log --oneline`, true],
	["cannot modify a file", `echo x >> ${CHECKOUT}/package.json`, false],
	["cannot create a file", `touch ${CHECKOUT}/new`, false],
	["cannot read .env", `cat ${CHECKOUT}/.env`, false],
	["cannot read through a link", `cat ${CHECKOUT}/leak`, false],
	["cannot read ~/.ssh", `cat ${HOME}/.ssh/id_rsa`, false],
	["cannot read ~/.git-credentials", `cat ${HOME}/.git-credentials`, false],
	["cannot read agent.env", "cat /var/tmp/ytimesy-secrets/agent.env", false],
	["cannot list the home", `ls ${HOME}`, false],
];

/** `umask` empty: the setup command keeps whatever the detached launch gives it. */
async function scenario(label: string, umask: string, acl: boolean) {
	sh(
		"root",
		`rm -rf ${CHECKOUT} ${HOME}/.ssh /tmp/ytimesy-detached /tmp/ytimesy-agents /tmp/ytimesy-sessions /var/tmp/ytimesy-secrets
if ${acl}; then [ -e /usr/bin/setfacl ] || mv /usr/bin/setfacl.off /usr/bin/setfacl; else [ -e /usr/bin/setfacl.off ] || mv /usr/bin/setfacl /usr/bin/setfacl.off; fi`,
	);
	forgetPreparedReaders();
	const id = randomBytes(8).toString("hex");
	const setup = await runDetachedCommand(
		async (command) => sh("ubuntu", command),
		id,
		[
			"bash",
			"-c",
			`set -e; ${umask ? `umask ${umask}; ` : ""}mkdir -p ${CHECKOUT}/.agents/skills/x ${HOME}/.ssh; cd ${CHECKOUT}
git init -q; echo '{}' > package.json; echo skill > .agents/skills/x/SKILL.md; echo SECRET=1 > .env
ln -s ${HOME}/.ssh/id_rsa leak; (umask 077; echo key > ${HOME}/.ssh/id_rsa; echo cred > ${HOME}/.git-credentials)
git add -A; git -c user.email=a@b.invalid -c user.name=a commit -qm init`,
		],
		{},
		60_000,
		Date.now() + 60_000,
		(ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 300))),
	);
	if (setup.exitCode) throw new Error(`setup failed: ${setup.stdout}`);
	sh(
		"ubuntu",
		`echo ${CHECKOUT} > /tmp/ytimesy-project-cwd; (umask 077; mkdir -p /var/tmp/ytimesy-secrets; echo S=1 > /var/tmp/ytimesy-secrets/agent.env)`,
	);
	const sessionId = `proof-${id}`;
	const reader = readerWorkspaceMachines(base, {
		sessionId,
		sessionRoot: `/tmp/ytimesy-sessions/${sessionId}`,
		scope: (text) => text,
	});
	const vm = WorkspaceId(name);
	const checks = [...CHECKS];
	let failed = 0;
	const check = async (what: string, command: string, want: boolean) => {
		const r = await reader.exec(vm, command);
		const ok = (r.exitCode === 0) === want;
		if (!ok) failed++;
		console.log(
			`${ok ? "PASS" : "FAIL"} [${label}] ${what}${ok ? "" : ` (exit ${r.exitCode}: ${r.stderr.trim().slice(0, 160)})`}`,
		);
	};
	for (const [what, command, want] of checks) await check(what, command, want);
	// Written by the builder after the reader was prepared, under umask 077.
	// Only a default ACL covers it; the mode fallback cannot.
	if (acl) {
		sh(
			"ubuntu",
			`cd ${CHECKOUT} && (umask 077; mkdir -p later && echo y > later/f.ts)`,
		);
		await check(
			"reads a file the builder wrote later under umask 077",
			`cat ${CHECKOUT}/later/f.ts`,
			true,
		);
	}
	const status = sh(
		"ubuntu",
		`git -C ${CHECKOUT} status --porcelain --untracked-files=no`,
	);
	const clean = status.exitCode === 0 && !status.stdout.trim();
	if (!clean) failed++;
	console.log(
		`${clean ? "PASS" : "FAIL"} [${label}] builder's git status stays clean`,
	);
	return failed;
}

ensureVmImage();
const started = spawnSync(
	"docker",
	["run", "-d", "--privileged", "--name", name, VM_IMAGE, "sleep", "infinity"],
	{ encoding: "utf8" },
);
if (started.status) throw new Error(started.stderr);
let failed = 0;
try {
	for (const [label, umask, acl] of [
		["detached setup, ACL", "", true],
		["umask-077 checkout, ACL", "077", true],
		["umask-077 checkout, no setfacl", "077", false],
	] as const)
		failed += await scenario(label, umask, acl);
} finally {
	spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}
console.log(failed ? `${failed} check(s) failed.` : "All checks passed.");
process.exit(failed ? 1 : 0);
