import { createHash } from "node:crypto";
import { z } from "zod";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	agentCapturesSummary,
	evidenceContentType,
	evidenceFileLimit,
	evidenceFileName,
	evidencePageUrl,
	evidenceVideoFile,
	renderAgentCapturesSection,
} from "#/domain/pr-evidence";
import {
	insertAgentCapture,
	listAgentCaptures,
} from "../adapters/pr-evidence-records";
import {
	type EvidenceStore,
	evidenceObjectKey,
	evidenceStoreConfigured,
	r2EvidenceStore,
} from "../adapters/pr-evidence-store";
import { readWorkspaceBytes, type WorkspaceShell } from "./pr-evidence";

/**
 * Screenshots and recordings the agent makes with `ytimesy-browser
 * screenshot|record` (lean-helpers.ts). Each is saved under
 * ~/.ytimesy/captures/ in the workspace, outside the repository, and
 * registered in ~/.ytimesy/captures/pending/. After the agent's command, the
 * runtime copies registered captures into private evidence storage, records
 * them on the chat (pr_evidence, source 'agent') so the chat shows them
 * inline, and the chat's pull request's Evidence section counts them and
 * links to their evidence page.
 */

/** Where ytimesy-browser keeps captures and their registrations in the workspace. */
export const AGENT_CAPTURES_DIRECTORY = "$HOME/.ytimesy/captures";

/** Lists registered captures (name, size, SHA-256) or forgets the ones stored (`done <id>...`). */
export const AGENT_CAPTURES_SCRIPT = `import hashlib, json, os, re, stat, sys
root = os.path.expanduser('~/.ytimesy/captures')
pending = os.path.join(root, 'pending')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,40}\\.(png|webm|mp4)$')
ID = re.compile(r'^[0-9a-f-]{36}$')
if sys.argv[1:2] == ['done']:
    for capture in sys.argv[2:]:
        if ID.match(capture):
            try: os.remove(os.path.join(pending, capture + '.json'))
            except OSError: pass
    sys.exit(0)
found = []
try: entries = sorted(os.listdir(pending))
except OSError: entries = []
for entry in entries:
    if not entry.endswith('.json') or not ID.match(entry[:-5]): continue
    spec_path = os.path.join(pending, entry)
    try:
        with open(spec_path, encoding='utf-8') as handle: spec = json.load(handle)
        name = spec['name']
        if not isinstance(name, str) or not NAME.match(name): raise ValueError(name)
        path = os.path.join(root, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode): raise ValueError(path)
        digest = hashlib.sha256()
        with open(path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b''): digest.update(chunk)
        seconds = spec.get('seconds')
        found.append({'id': entry[:-5], 'name': name, 'path': path, 'bytes': info.st_size, 'sha256': digest.hexdigest(), 'seconds': seconds if isinstance(seconds, (int, float)) else None, 'capturedAt': str(spec.get('capturedAt') or '')[:40]})
    except (OSError, ValueError, KeyError, TypeError):
        try: os.remove(spec_path)
        except OSError: pass
    if len(found) >= 20: break
print(json.dumps(found))`;

const listed = z.array(
	z.object({
		id: z.string().regex(/^[0-9a-f-]{36}$/),
		name: z.string().refine(evidenceFileName),
		path: z.string().max(4096),
		bytes: z.number().int().min(0),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		seconds: z.number().min(0).max(3600).nullable(),
		capturedAt: z.string().max(40),
	}),
);

/** The stored capture's id: one per chat and workspace capture, so a retried collection stores it once. */
export function agentCaptureId(sessionId: string, captureId: string) {
	const hex = createHash("sha256")
		.update(`agent-capture:${sessionId}:${captureId}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type CollectedCapture = {
	readonly name: string;
	readonly evidenceId: string;
	/** Null when it was stored; otherwise why it is not shown. */
	readonly problem: string | null;
};

export type AgentCaptureDependencies = {
	/** Private media storage, or null when none is configured. */
	store(): EvidenceStore | null;
	insert: typeof insertAgentCapture;
	list: typeof listAgentCaptures;
	appUrl(): string | undefined;
};

const defaults: AgentCaptureDependencies = {
	store: () => (evidenceStoreConfigured() ? r2EvidenceStore : null),
	insert: insertAgentCapture,
	list: listAgentCaptures,
	appUrl: () => process.env.APP_URL,
};

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * Stores the captures registered in the workspace since the last collection
 * and records them on the chat; `itemId` is the tool call they were made in.
 * A capture over its size limit is dropped with a reason; one that could not
 * be stored stays registered for the next collection.
 */
export async function collectAgentCaptures(
	input: {
		shell: WorkspaceShell;
		userId: string;
		projectId: string;
		sessionId: string;
		itemId: string | null;
	},
	deps: AgentCaptureDependencies = defaults,
): Promise<CollectedCapture[]> {
	const store = deps.store();
	if (!store) return [];
	const listing = await input.shell(
		`python3 -c ${quote(AGENT_CAPTURES_SCRIPT)} list`,
		30_000,
	);
	if (listing.exitCode) return [];
	let captures: z.infer<typeof listed>;
	try {
		captures = listed.parse(JSON.parse(listing.stdout.trim() || "[]"));
	} catch {
		return [];
	}
	const collected: CollectedCapture[] = [];
	const done: string[] = [];
	for (const capture of captures) {
		const evidenceId = agentCaptureId(input.sessionId, capture.id);
		const contentType = evidenceContentType(capture.name);
		const limit = evidenceFileLimit(capture.name);
		if (!contentType || capture.bytes > limit) {
			done.push(capture.id);
			collected.push({
				name: capture.name,
				evidenceId,
				problem: `over the ${megabytes(limit)} MB limit${evidenceVideoFile(capture.name) ? "; record fewer seconds" : ""}`,
			});
			continue;
		}
		try {
			const data = await readWorkspaceBytes(input.shell, capture.path, capture);
			await store.put(
				evidenceObjectKey(input, evidenceId, capture.name),
				data,
				contentType,
			);
			await deps.insert({
				id: evidenceId,
				userId: input.userId,
				projectId: input.projectId,
				sessionId: input.sessionId,
				itemId: input.itemId,
				file: {
					name: capture.name,
					bytes: capture.bytes,
					sha256: capture.sha256,
				},
				videoSeconds: evidenceVideoFile(capture.name) ? capture.seconds : null,
				capturedAt: capture.capturedAt || null,
			});
			done.push(capture.id);
			collected.push({ name: capture.name, evidenceId, problem: null });
		} catch (error) {
			console.warn("An agent capture was not stored.", {
				message:
					error instanceof Error ? error.message.slice(0, 300) : "unknown",
			});
			collected.push({
				name: capture.name,
				evidenceId,
				problem: "could not be stored; it is retried after your next command",
			});
		}
	}
	if (done.length)
		await input
			.shell(
				`python3 -c ${quote(AGENT_CAPTURES_SCRIPT)} done ${done.map(quote).join(" ")}`,
				15_000,
			)
			.catch(() => undefined);
	return collected;
}

/** What the agent is told in the command's result about its captures. */
export function agentCapturesNote(collected: readonly CollectedCapture[]) {
	const shown = collected.filter((capture) => !capture.problem);
	const missing = collected.filter((capture) => capture.problem);
	return [
		shown.length
			? `Shown in the chat and linked from the pull request's Evidence section: ${shown.map((capture) => capture.name).join(", ")}. Do not add these files to the repository unless the user asked for that.`
			: "",
		...missing.map(
			(capture) => `Not shown: ${capture.name} (${capture.problem}).`,
		),
	]
		.filter(Boolean)
		.join(" ");
}

/** Agent captures counted in a pull request's Evidence section (the page shows every one). */
const CAPTURES_COUNTED = 60;

/**
 * The pull request's Evidence section for a chat's agent captures: how many
 * there are and a link to the evidence page (sign-in required), which shows
 * all of them. Null when the chat has none.
 */
export async function agentCapturesPullRequestSection(
	input: { userId: string; projectId: string; sessionId: string },
	deps: AgentCaptureDependencies = defaults,
) {
	const records = await deps.list(
		input.userId,
		input.projectId,
		input.sessionId,
		CAPTURES_COUNTED,
	);
	const newest = records[0];
	if (!newest) return null;
	return renderAgentCapturesSection({
		summary: agentCapturesSummary(records),
		pageUrl: evidencePageUrl(deps.appUrl(), input.projectId, newest.id),
	});
}
