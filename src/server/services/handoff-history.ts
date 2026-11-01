import type { WorkspaceId } from "#/domain/ids";
import {
	HANDOFF_HOME_FOLDER,
	type HandoffIndexEntry,
	handoffFolderName,
	handoffIndexMarkdown,
} from "#/domain/local-import";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { readHandoffObject } from "../adapters/handoff-store";
import type { ImportedSessionRow } from "../adapters/local-imports";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * A project's imported local sessions on a chat's machine, at
 * ~/.ytimesy/handoff/<agent>-<session>/transcript.md (with its images) and an
 * INDEX.md that lists them, so the agent can grep the full history. Newest
 * sessions come first, within a per-machine byte budget; a transcript already
 * there (same import, same size) is not written again.
 */
export const HANDOFF_MACHINE_BUDGET_BYTES = 150 * 1024 * 1024;
const STAGING = "/tmp/ytimesy-handoff-staging";
/** Base64 characters per staged write, so no single provider call carries a whole archive. */
const CHUNK_CHARS = 4 * 1024 * 1024;
const HOME_DIRECTORY = `"$HOME/${HANDOFF_HOME_FOLDER}"`;

/** The sessions whose transcripts go on the machine: newest first, within the budget. */
export function handoffSessionsForMachine(
	sessions: readonly ImportedSessionRow[],
	budget = HANDOFF_MACHINE_BUDGET_BYTES,
) {
	const chosen: ImportedSessionRow[] = [];
	let used = 0;
	for (const session of [...sessions].sort(
		(a, b) => b.sourceUpdatedAt.getTime() - a.sourceUpdatedAt.getTime(),
	)) {
		if (session.transcriptBytes === null) continue;
		if (used + session.transcriptBytes > budget) continue;
		used += session.transcriptBytes;
		chosen.push(session);
	}
	return chosen;
}

/** Marks a written transcript: a re-import (new size) is written again. */
const marker = (session: ImportedSessionRow) =>
	`${session.id}-${session.transcriptBytes ?? 0}`;

export async function materializeHandoffHistory(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	userId: string,
	sessions: readonly ImportedSessionRow[],
	read: typeof readHandoffObject = readHandoffObject,
) {
	if (!sessions.length) return;
	const chosen = handoffSessionsForMachine(sessions);
	const listed = await machines.exec(
		vm,
		`d=${HOME_DIRECTORY}; mkdir -p "$d/.imported" ${quote(STAGING)} && chmod 700 "$HOME/.ytimesy" "$d" ${quote(STAGING)} && for m in ${chosen.map((session) => quote(marker(session))).join(" ") || "''"}; do [ -f "$d/.imported/$m" ] && printf '%s\\n' "$m"; done; true`,
		15_000,
	);
	if (listed.exitCode)
		throw new Error("Could not prepare imported sessions in the workspace.");
	const present = new Set(listed.stdout.split("\n").filter(Boolean));
	const written = new Set<string>();
	for (const session of chosen) {
		if (present.has(marker(session))) {
			written.add(session.id);
			continue;
		}
		try {
			const archive = await read(
				{ userId, projectId: session.projectId },
				session.id,
				"transcript.tgz",
			);
			if (!archive) continue;
			const base64 = Buffer.from(archive).toString("base64");
			const parts: string[] = [];
			for (let at = 0; at < base64.length; at += CHUNK_CHARS) {
				const part = `${STAGING}/${session.id}.${parts.length}.b64`;
				await machines.writeTextFile(
					vm,
					part,
					base64.slice(at, at + CHUNK_CHARS),
				);
				parts.push(part);
			}
			const folder = `"$d/"${quote(handoffFolderName(session.tool, session.sourceSessionId))}`;
			const staged = quote(`${STAGING}/${session.id}.tgz`);
			const extracted = await machines.exec(
				vm,
				`d=${HOME_DIRECTORY}; cat ${parts.map(quote).join(" ")} | base64 -d > ${staged} && rm -rf ${folder} && mkdir -p ${folder} && tar -xzf ${staged} -C ${folder} --no-same-owner && touch "$d/.imported/"${quote(marker(session))}; s=$?; rm -f ${staged} ${parts.map(quote).join(" ")}; exit $s`,
				120_000,
			);
			if (extracted.exitCode) throw new Error(extracted.stderr.slice(0, 300));
			written.add(session.id);
		} catch (error) {
			// One unreadable transcript must not hide the others.
			console.warn("An imported session's transcript was not restored.", {
				message: (error as Error).message,
			});
		}
	}
	const entries: HandoffIndexEntry[] = sessions.map((session) => ({
		tool: session.tool,
		sourceSessionId: session.sourceSessionId,
		title: session.title,
		turnCount: session.turnCount,
		updatedAt: session.sourceUpdatedAt.toISOString(),
		present: written.has(session.id),
	}));
	const index = `${STAGING}/INDEX.md`;
	await machines.writeTextFile(vm, index, handoffIndexMarkdown(entries));
	const moved = await machines.exec(
		vm,
		`d=${HOME_DIRECTORY}; cat ${quote(index)} > "$d/INDEX.md" && rm -f ${quote(index)}`,
		15_000,
	);
	if (moved.exitCode)
		throw new Error("Could not write the imported sessions index.");
}
