import { Effect } from "effect";
import { parseClaudeHomePath } from "#/domain/claude-auth";
import {
	CLAUDE_HOME_FILE_NAMES,
	type ClaudeHomeFiles,
	claudeHomeFilesAreUsable,
	parseClaudeHomeDump,
} from "#/domain/claude-home";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	loadClaudeHomeForUser,
	saveClaudeHomeForUser,
} from "#/server/secrets/claude-home-store";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const SIBLING_HOMES = ["/home/ubuntu", "/root"] as const;
const MAX_SIBLING_READS = 3;

const DUMP_HOME_SCRIPT = `python3 - <<'PY'
import json, os, pathlib
home = os.environ.get("HOME") or "/root"
files = {}
for rel in (".claude.json", ".claude/.credentials.json"):
    path = pathlib.Path(home) / rel
    if path.is_file():
        files[rel] = path.read_text()
print(json.dumps({"home": home, "files": files}))
PY`;

export type ClaudeHomeRestore = {
	readonly userId: string;
	readonly siblingProviderRefs: readonly string[];
};

export function captureClaudeHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	userId: string,
): Effect.Effect<void> {
	if (!userId.trim()) return Effect.void;
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`bash -lc ${posixShellQuoted(DUMP_HOME_SCRIPT)}`,
			15_000,
		),
	).pipe(
		Effect.flatMap((result) => {
			const home = parseClaudeHomeDump(result.stdout);
			if (!home) return Effect.void;
			return Effect.tryPromise(() => saveClaudeHomeForUser(userId, home));
		}),
		Effect.catchAll(() => Effect.void),
	);
}

export function restoreClaudeHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	homePath: string,
	input: ClaudeHomeRestore,
): Effect.Effect<boolean> {
	const dest = parseClaudeHomePath(`CLAUDE_HOME=${homePath}`) ?? homePath.trim();
	if (!dest) return Effect.succeed(false);
	return Effect.gen(function* () {
		const stored = yield* Effect.tryPromise(() =>
			loadClaudeHomeForUser(input.userId),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		if (stored && (yield* writeClaudeHome(machines, workspaceId, dest, stored))) {
			return true;
		}
		for (const sibling of input.siblingProviderRefs.slice(0, MAX_SIBLING_READS)) {
			if (sibling === String(workspaceId)) continue;
			const copied = yield* readSiblingClaudeHome(machines, sibling);
			if (!copied) continue;
			if (yield* writeClaudeHome(machines, workspaceId, dest, copied)) {
				yield* Effect.tryPromise(() =>
					saveClaudeHomeForUser(input.userId, copied),
				).pipe(Effect.catchAll(() => Effect.void));
				return true;
			}
		}
		return false;
	});
}

function readSiblingClaudeHome(
	machines: WorkspaceMachines,
	providerRef: string,
): Effect.Effect<ClaudeHomeFiles | null> {
	return Effect.gen(function* () {
		const files: Partial<ClaudeHomeFiles["files"]> = {};
		for (const home of SIBLING_HOMES) {
			for (const name of CLAUDE_HOME_FILE_NAMES) {
				if (files[name]) continue;
				const contents = yield* Effect.tryPromise(() =>
					machines.readTextFile(WorkspaceId(providerRef), `${home}/${name}`),
				).pipe(Effect.catchAll(() => Effect.succeed(null)));
				if (contents?.trim()) files[name] = contents;
			}
			if (claudeHomeFilesAreUsable(files)) return { files };
		}
		return null;
	});
}

function writeClaudeHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	homePath: string,
	home: ClaudeHomeFiles,
): Effect.Effect<boolean> {
	if (!claudeHomeFilesAreUsable(home.files)) return Effect.succeed(false);
	return Effect.gen(function* () {
		for (const name of CLAUDE_HOME_FILE_NAMES) {
			const contents = home.files[name];
			if (!contents) continue;
			const path = `${homePath}/${name}`;
			const parent = path.slice(0, path.lastIndexOf("/"));
			yield* Effect.tryPromise(() =>
				machines.exec(
					workspaceId,
					`bash -lc ${posixShellQuoted(`mkdir -p ${posixShellQuoted(parent)}`)}`,
					10_000,
				),
			);
			yield* Effect.tryPromise(() =>
				machines.writeTextFile(workspaceId, path, contents),
			);
			yield* Effect.tryPromise(() =>
				machines.exec(
					workspaceId,
					`bash -lc ${posixShellQuoted(`chmod 600 ${posixShellQuoted(path)}`)}`,
					10_000,
				),
			);
		}
		return true;
	}).pipe(Effect.catchAll(() => Effect.succeed(false)));
}
