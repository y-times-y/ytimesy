import { createHash } from "node:crypto";
import type { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "./workspace-machines";

/*
 * What remains of reviewed-task import (the retired lead/child architecture):
 * exporting a checkout's changes as one exact patch. The frozen production
 * evaluation (benchmarks/evaluation/production.ts) grades with it.
 */

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
