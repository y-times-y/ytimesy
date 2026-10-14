import { createHash, randomUUID } from "node:crypto";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
} from "../adapters/agent-sessions";
import {
	recordTaskImport,
	taskPatchEvidence,
} from "../adapters/task-patch-evidence";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { deferredApiTurnWorkspace } from "./api-turn-workspace";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export const exportTaskPatchCommand = `set -eu
cd "$(cat /tmp/ytimesy-project-cwd)"
temporary=$(mktemp -d /tmp/ytimesy-patch.XXXXXXXX)
trap 'rm -f "$temporary/index" "$temporary/index.lock" "$temporary/patch"; rmdir "$temporary"' EXIT
export GIT_INDEX_FILE="$temporary/index"
git read-tree HEAD
git -c core.fsmonitor=false -c core.hooksPath=/dev/null add -A -- .
base=HEAD
if git show-ref --verify --quiet refs/ytimesy/base; then base=refs/ytimesy/base; fi
git diff --cached --binary --full-index --no-ext-diff "$base" -- . > "$temporary/patch"
python3 -c 'import base64,json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1])
if p.stat().st_size > ${MAX_PATCH_BYTES}: raise ValueError("Patch exceeds transfer limit")
print(json.dumps({"base":subprocess.check_output(["git","rev-parse",sys.argv[2]],text=True).strip(),"patch":base64.b64encode(p.read_bytes()).decode()}))' "$temporary/patch" "$base"`;

/** Git checks the complete patch before applying it; conflicts never use rejects or a forced overwrite. */
function applyTaskPatchCommand(input: {
	directory: string;
	base: string;
	patchPath: string;
	sha256: string;
}) {
	if (!/^[a-f0-9]{40,64}$/.test(input.base))
		throw new Error("Invalid patch base.");
	if (!/^[a-f0-9]{64}$/.test(input.sha256))
		throw new Error("Invalid patch hash.");
	return `set -eu
cd ${quote(input.directory)}
python3 -c ${quote("import fcntl, os, subprocess, sys\nwith os.fdopen(os.open('.git/ytimesy-import.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:\n    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)\n    subprocess.run(['sh', '-c', sys.argv[1]], check=True)")} ${quote(`set -eu
if git show-ref --verify --quiet refs/ytimesy/imports/${input.sha256}; then
 test "$(git rev-parse refs/ytimesy/imports/${input.sha256})" = ${quote(input.base)} || { echo 'Recorded import has a different base revision.' >&2; exit 1; }
 exit 0
fi
test "$(git rev-parse HEAD)" = ${quote(input.base)} || { echo 'Integration checkout has a different base revision.' >&2; exit 1; }
if git -c core.hooksPath=/dev/null apply --check --binary -- ${quote(input.patchPath)}; then
 git -c core.hooksPath=/dev/null apply --binary -- ${quote(input.patchPath)}
else
 git -c core.hooksPath=/dev/null apply --reverse --check --binary -- ${quote(input.patchPath)}
fi
git update-ref refs/ytimesy/imports/${input.sha256} ${quote(input.base)}
git status --short`)}
`;
}

function assertReviewedSibling(
	destination: AgentSessionRecord,
	source: AgentSessionRecord | null,
) {
	if (
		!destination.parentSessionId ||
		destination.taskAccess !== "read_write" ||
		destination.taskPlacement !== "fresh"
	)
		throw new Error(
			"Only a fresh writable builder can import reviewed sibling changes.",
		);
	if (
		!source ||
		source.id === destination.id ||
		source.userId !== destination.userId ||
		source.projectId !== destination.projectId ||
		source.parentSessionId !== destination.parentSessionId ||
		source.taskAccess !== "read_write" ||
		source.taskPlacement !== "fresh" ||
		source.taskState !== "done" ||
		source.taskReviewState !== "reviewed" ||
		!source.providerRef
	)
		throw new Error(
			"Import requires a completed, reviewed writable sibling in the same coordination group.",
		);
}

export function taskPatchPreview(
	patch: { bytes: Buffer; sha256: string; base: string },
	start = 0,
) {
	const diff = patch.bytes.toString("utf8");
	const nextStart = diff.length > start + 60_000 ? start + 60_000 : null;
	return {
		diff: diff.slice(start, start + 60_000),
		truncated: nextStart !== null,
		nextStart,
		sha256: patch.sha256,
		base: patch.base,
	};
}

/** Captures committed and working-tree changes since the saved checkout base without changing the real index. */
export async function captureTaskPatch(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
) {
	const exported = await machines.exec(vm, exportTaskPatchCommand, 30_000);
	if (exported.exitCode) throw new Error("Task changes could not be exported.");
	const transfer = JSON.parse(exported.stdout) as {
		base: string;
		patch: string;
	};
	if (
		typeof transfer.base !== "string" ||
		!/^[a-f0-9]{40,64}$/.test(transfer.base)
	)
		throw new Error("Task patch base is invalid.");
	if (
		typeof transfer.patch !== "string" ||
		transfer.patch.length > Math.ceil(MAX_PATCH_BYTES / 3) * 4
	)
		throw new Error("Task patch exceeds the transfer limit.");
	const patch = Buffer.from(transfer.patch, "base64");
	if (patch.toString("base64") !== transfer.patch)
		throw new Error("Task patch encoding is invalid.");
	if (patch.length > MAX_PATCH_BYTES)
		throw new Error("Task patch exceeds the transfer limit.");
	return {
		...transfer,
		bytes: patch,
		sha256: createHash("sha256").update(patch).digest("hex"),
	};
}

/** Imports code, not publication or acceptance. The integrating builder must verify the combined checkout. */
export async function importReviewedTaskChanges(
	machines: WorkspaceMachines,
	destination: AgentSessionRecord,
	sourceId: string,
	expectedSha256: string,
	preparedWorkspace?: AgentToolWorkspace,
) {
	if (preparedWorkspace && preparedWorkspace.vm !== destination.providerRef)
		throw new Error(
			"Prepared import workspace does not match the destination.",
		);
	const source = await agentSessionForOwner(destination.userId, sourceId);
	assertReviewedSibling(destination, source);
	if (!/^[a-f0-9]{64}$/.test(expectedSha256))
		throw new Error(
			"Provide the exact patch hash from the parent's diff inspection.",
		);
	if (!source?.providerRef)
		throw new Error("Reviewed source workspace is unavailable.");
	const evidence = await taskPatchEvidence(destination.userId, [
		source.parentSessionId as string,
	]);
	const accepted = evidence.reviews.get(sourceId);
	if (!accepted || accepted.sha256 !== expectedSha256)
		throw new Error(
			"Import must match the exact patch accepted by the parent review.",
		);
	const sourceMachines = machinesForAgentSession(machines, source);
	const transfer = await captureTaskPatch(
		sourceMachines,
		WorkspaceId(source.providerRef),
	);
	const { bytes: patch, sha256 } = transfer;
	if (sha256 !== expectedSha256 || transfer.base !== accepted.base)
		throw new Error(
			"Source changes differ from the inspected patch; request a new parent review.",
		);
	if (!patch.length || patch.length > MAX_PATCH_BYTES)
		throw new Error(
			"Reviewed task has no transferable patch or exceeds the limit.",
		);
	const current = await agentSessionForOwner(destination.userId, sourceId);
	assertReviewedSibling(destination, current);
	if (current?.providerRef !== source.providerRef)
		throw new Error("Reviewed source workspace changed; inspect it again.");
	const currentEvidence = await taskPatchEvidence(destination.userId, [
		source.parentSessionId as string,
	]);
	const currentAcceptance = currentEvidence.reviews.get(sourceId);
	if (
		currentAcceptance?.sha256 !== sha256 ||
		currentAcceptance.base !== transfer.base
	)
		throw new Error(
			"Parent acceptance changed; request its current reviewed patch.",
		);
	const {
		machines: targetMachines,
		vm,
		cwd,
	} = preparedWorkspace ??
	(await deferredApiTurnWorkspace(
		machines,
		destination,
		new AbortController().signal,
	)());
	if (vm === source.providerRef)
		throw new Error("Integration requires an isolated writable workspace.");
	const patchPath = `/tmp/ytimesy-import-${randomUUID()}.patch`;
	const command = applyTaskPatchCommand({
		directory: cwd,
		base: transfer.base,
		patchPath,
		sha256,
	});
	const decodeCommand = `python3 -c ${quote("import base64, hashlib, pathlib, sys\npatch = base64.b64decode(pathlib.Path(sys.argv[2]).read_text(), validate=True)\nif hashlib.sha256(patch).hexdigest() != sys.argv[3]: raise ValueError('Transferred patch hash differs from reviewed patch')\nwith open(sys.argv[1], 'xb') as f: f.write(patch)")} ${quote(patchPath)} ${quote(`${patchPath}.b64`)} ${quote(sha256)}`;
	try {
		await targetMachines.writeTextFile(vm, `${patchPath}.b64`, transfer.patch);
		// Decode and apply in one guest call; failed decoding cannot reach Git.
		const applied = await targetMachines.exec(
			vm,
			`set -eu\n${decodeCommand}\n${command}`,
			45_000,
		);
		if (applied.exitCode)
			throw new Error(
				"Reviewed patch transfer failed, conflicts or its base differs; inspect the destination. No forced merge was used.",
			);
		await recordTaskImport(destination.userId, destination.id, {
			taskId: sourceId,
			sha256,
			base: transfer.base,
		});
		return {
			taskId: sourceId,
			sha256,
			bytes: patch.length,
			status: "imported",
			verificationRequired: true,
		};
	} finally {
		await targetMachines.exec(
			vm,
			`rm -f -- ${quote(patchPath)} ${quote(`${patchPath}.b64`)}`,
			15_000,
		);
	}
}
