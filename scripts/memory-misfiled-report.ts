// Lists personal/ memory lines that look like one project's (a dry run: it
// only prints, never writes a file, a repo or the database).
//
//   git clone <memory repo> /tmp/memory-u1
//   node --import tsx scripts/memory-misfiled-report.ts --dir /tmp/memory-u1
//       Every personal/ line looksProjectSpecific flags (memory-repo.ts: a
//       project mark such as inline code, a file path or a data word, and
//       nothing about the user), with its source chat id.
//   node --env-file=.env --import tsx scripts/memory-misfiled-report.ts --dir /tmp/memory-u1 --user <user id>
//       Also resolves each line's `source:` chat to its project (read-only
//       query, the user's own chats only) and proposes the destination
//       file, projects/<key>/<topic>.md, as the save hook would file it now.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
	type MemoryProject,
	memoryPathScope,
	projectFolderPath,
	projectKeyFor,
	topicFileName,
} from "../src/domain/memory-layout";
import {
	chatIdFromSource,
	looksProjectSpecific,
	type MemoryFiles,
	memoryLines,
} from "../src/domain/memory-repo";

const { values: flags } = parseArgs({
	options: {
		dir: { type: "string" },
		user: { type: "string" },
	},
});

/** Every .md file under `dir` (no .git), keyed by its repo path. */
async function readMemory(dir: string): Promise<MemoryFiles> {
	const files: MemoryFiles = {};
	for (const entry of await readdir(dir, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = relative(dir, join(entry.parentPath, entry.name));
		if (path.split("/").includes(".git")) continue;
		files[path] = await readFile(join(dir, path), "utf8");
	}
	return files;
}

async function main() {
	if (!flags.dir)
		throw new Error(
			"Usage: --dir <a clone of the memory repo> [--user <user id>]",
		);
	const files = await readMemory(flags.dir);
	const flagged = memoryLines(files).filter(
		(entry) =>
			memoryPathScope(entry.path).kind === "personal" &&
			looksProjectSpecific(entry.text),
	);
	const chatProject = new Map<string, MemoryProject | null>();
	let closeDatabase: (() => Promise<void>) | null = null;
	if (flags.user && flagged.length) {
		const { memoryChat } = await import(
			"../src/server/adapters/memory-settings"
		);
		closeDatabase = (await import("../src/server/adapters/database"))
			.closeDatabase;
		for (const entry of flagged) {
			const chatId = chatIdFromSource(entry.meta.source ?? "");
			if (!chatId || chatProject.has(chatId)) continue;
			const chat = await memoryChat(flags.user, chatId).catch(() => null);
			chatProject.set(chatId, chat?.projectRef ?? null);
		}
	}
	try {
		console.log(
			`${flagged.length} of ${memoryLines(files).filter((entry) => memoryPathScope(entry.path).kind === "personal").length} personal/ lines look project-specific (dry run: nothing is changed).\n`,
		);
		for (const entry of flagged) {
			const chatId = chatIdFromSource(entry.meta.source ?? "");
			const project = chatId ? chatProject.get(chatId) : undefined;
			const destination = project
				? `${projectFolderPath(projectKeyFor(files, project))}/${topicFileName(entry.path)}`
				: `projects/<the source chat's project>/${topicFileName(entry.path)}`;
			const from = !chatId
				? "no source chat"
				: project
					? `chat ${chatId} in ${project.fullName}`
					: project === null
						? `chat ${chatId} (no project, or not found)`
						: `chat ${chatId} (pass --user to resolve its project)`;
			console.log(`${entry.path}:${entry.line}: ${entry.text}`);
			console.log(`  from ${from}`);
			console.log(`  -> ${destination}\n`);
		}
	} finally {
		await closeDatabase?.();
	}
}

await main();
