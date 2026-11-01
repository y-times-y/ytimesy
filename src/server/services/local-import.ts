import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { z } from "zod";
import { scratchRepositoryName } from "#/domain/add-project";
import { DEFAULT_COMPOSER_HARNESS_ID } from "#/domain/agent-provider";
import { SessionItemId } from "#/domain/ids";
import {
	bearerImportToken,
	type createProjectRequest,
	draftEnvironmentRecipe,
	type finishRequest,
	HANDOFF_DIRECTORY,
	handoffBranch,
	handoffContextText,
	handoffDocument,
	IMPORT_CODE_TTL_MS,
	IMPORT_TOKEN_TTL_MS,
	importCodeRefusal,
	importedSecretValues,
	importSecretHash,
	importTokenUsable,
	LOCAL_AGENT_NAMES,
	type LocalImportView,
	localImportViewStatus,
	looksGzipped,
	newImportCode,
	newImportToken,
	normalizeImportCode,
	type PlanProject,
	type PlanRequest,
	planLocalImport,
	type secretsRequest,
	type sessionUploadRequest,
	type startRequest,
} from "#/domain/local-import";
import { localImportPrompt } from "#/domain/local-import-prompt";
import {
	type Project,
	projectDisplayName,
	repositoriesForProject,
} from "#/domain/projects";
import type { HandoffSessionItem } from "#/domain/session-item";
import {
	insertAgentSession,
	listAgentSessions,
	saveAgentSessionItems,
	saveSessionWorkingBranch,
} from "../adapters/agent-sessions";
import { latestEnvironmentRecipes } from "../adapters/environment-recipes";
import {
	githubRepositoryCreation,
	listAuthorizedRepositories,
	repositoryBranchSha,
} from "../adapters/github";
import {
	readHandoffObject,
	storeHandoffObject,
} from "../adapters/handoff-store";
import {
	importedSessionBySource,
	importedSessionOfImport,
	insertLocalImport,
	type LocalImportRow,
	localImportByCodeHash,
	localImportByTokenHash,
	localImportForOwner,
	redeemLocalImportCode,
	saveImportedSession,
	saveImportedTranscriptSize,
	saveLocalImportProgress,
} from "../adapters/local-imports";
import { listProjects, projectForOwner } from "../adapters/projects";
import {
	consumeUserAction,
	requireUserAction,
} from "../adapters/user-action-rate";
import { workspaceForProject } from "../adapters/workspaces";
import {
	githubAccessToken,
	githubConnectionExists,
} from "../auth/github-connection";
import { serverConfig } from "../config";
import { saveProjectEnvironment } from "./project-environment-setup";
import { saveImportedProjectSecrets } from "./project-secrets";
import { createScratchProject } from "./projects";
import { enqueueProjectWorkspace } from "./workspaces";

/**
 * "Continue your agent session". The web card creates an import and its
 * one-time code; the local agent runs `npx ytimesy continue --code <code>`,
 * and the CLI calls /api/local-import/* with the token start returned:
 * start → plan → (create-project) → secrets → sessions (+ transcript) → finish.
 * Every call is scoped to the import's user; nothing starts a model turn.
 */

const refuse = (message: string, status: number): never => {
	throw new Response(message, { status });
};

// ---- the web card -------------------------------------------------------------

/** Copy prompt: a new import with its code, and the prompt that carries it. */
export async function createLocalImport(userId: string) {
	if (!(await githubConnectionExists(userId)))
		throw new Error("Connect GitHub first.");
	await consumeUserAction(userId, "local-import-code");
	const code = newImportCode();
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + IMPORT_CODE_TTL_MS);
	await insertLocalImport({
		id,
		userId,
		codeHash: importSecretHash(code),
		codeExpiresAt: expiresAt,
	});
	return {
		importId: id,
		prompt: localImportPrompt(code),
		expiresAt: expiresAt.toISOString(),
	};
}

export function localImportView(
	row: LocalImportRow,
	now = new Date(),
): LocalImportView {
	return {
		id: row.id,
		status: localImportViewStatus(row, now),
		sessionsPlanned: row.sessionsPlanned,
		sessionsImported: row.sessionsImported,
		projectId: row.projectId,
		sessionId: row.sessionId,
		message: row.message,
	};
}

/** The card's status line polls this. */
export async function localImportStatus(userId: string, importId: string) {
	const row = await localImportForOwner(userId, importId);
	if (!row) throw new Error("This import is not available.");
	return localImportView(row);
}

// ---- the CLI ------------------------------------------------------------------

export type ImportCaller = {
	readonly importId: string;
	readonly userId: string;
	readonly row: LocalImportRow;
};

/**
 * The caller of a CLI route, from `Authorization: Bearer <token>`. Finish may
 * be repeated after it succeeded (a lost reply), so it accepts a finished
 * import while the token lasts.
 */
export async function requireImportCaller(
	request: Request,
	options: { readonly finished?: boolean } = {},
): Promise<ImportCaller> {
	const token = bearerImportToken(request.headers.get("authorization"));
	if (!token)
		refuse("Send the import token as Authorization: Bearer <token>.", 401);
	const row = await localImportByTokenHash(importSecretHash(token as string));
	if (!row) return refuse("This import token is not valid.", 401);
	const now = new Date();
	const usable =
		importTokenUsable(row, now) ||
		(options.finished === true &&
			row.status === "ready" &&
			row.tokenExpiresAt !== null &&
			row.tokenExpiresAt.getTime() > now.getTime());
	if (!usable)
		refuse(
			row.status === "ready"
				? "This import already finished."
				: "This import expired. Copy a new prompt in ytimesy.",
			401,
		);
	await requireUserAction(row.userId, "local-import-call");
	return { importId: row.id, userId: row.userId, row };
}

function planProjects(projects: readonly Project[]): PlanProject[] {
	return projects.map((project) => ({
		id: project.id,
		name: projectDisplayName(project),
		repositories: repositoriesForProject(project).map((repo) => repo.fullName),
	}));
}

async function repositoryCreation(userId: string) {
	try {
		return await githubRepositoryCreation(await githubAccessToken(userId));
	} catch {
		return { owner: null, canCreate: false };
	}
}

/** Spends the code and returns the token, the user's projects and whether a repository can be created. */
export async function startLocalImport(input: z.infer<typeof startRequest>) {
	const code = normalizeImportCode(input.code);
	if (!code)
		refuse("This code is not valid. Copy a new prompt in ytimesy.", 400);
	const token = newImportToken();
	const tokenExpiresAt = new Date(Date.now() + IMPORT_TOKEN_TTL_MS);
	const codeHash = importSecretHash(code as string);
	const row = await redeemLocalImportCode({
		codeHash,
		tokenHash: importSecretHash(token),
		tokenExpiresAt,
		agent: input.agent ?? null,
	});
	if (!row)
		return refuse(
			importCodeRefusal(await localImportByCodeHash(codeHash), new Date()),
			410,
		);
	const [projects, creation] = await Promise.all([
		listProjects(row.userId),
		repositoryCreation(row.userId),
	]);
	return {
		token,
		expiresAt: tokenExpiresAt.toISOString(),
		appUrl: serverConfig().APP_URL,
		projects: planProjects(projects),
		canCreateRepository: creation.canCreate,
		repositoryOwner: creation.owner,
	};
}

/** For each folder of local sessions: where it goes, or what the user must decide. */
export async function planImport(caller: ImportCaller, request: PlanRequest) {
	const config = serverConfig();
	const githubToken = await githubAccessToken(caller.userId);
	const [projects, reachable, creation] = await Promise.all([
		listProjects(caller.userId),
		listAuthorizedRepositories(githubToken),
		repositoryCreation(caller.userId),
	]);
	return {
		groups: planLocalImport({
			groups: request.groups,
			projects: planProjects(projects),
			reachable: new Map(
				reachable.map((repository) => [
					repository.fullName,
					repository.private,
				]),
			),
			canCreateRepository: creation.canCreate,
			connectUrl: `${config.APP_URL}/?addProject=1`,
			installationUrl: `https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new`,
		}),
	};
}

/**
 * A folder that is not a GitHub repository becomes a new, empty private
 * repository and its project (the existing new-repository flow). The CLI
 * pushes with the user's own Git credentials; no ytimesy token leaves here.
 */
export async function createImportProject(
	caller: ImportCaller,
	request: z.infer<typeof createProjectRequest>,
) {
	await requireUserAction(caller.userId, "project-create");
	const name = scratchRepositoryName(request.name);
	if (!name) refuse("Repository name is invalid.", 400);
	const result = await Effect.runPromise(
		Effect.either(
			createScratchProject(caller.userId, name as string, undefined, {
				empty: true,
			}),
		),
	);
	if (result._tag === "Left") throw result.left.error;
	const { project, repository } = result.right;
	return {
		projectId: project.id,
		repository: repository.fullName,
		defaultBranch: repository.defaultBranch,
		cloneUrl: `https://github.com/${repository.fullName}.git`,
		sshUrl: `git@github.com:${repository.fullName}.git`,
	};
}

async function requireOwnedProject(userId: string, projectId: string) {
	const project = await projectForOwner(userId, projectId);
	if (!project) refuse("Project is not available.", 404);
	return project as Project;
}

/** .env and .env.local values, saved as the project's secrets for review. */
export async function importSecrets(
	caller: ImportCaller,
	request: z.infer<typeof secretsRequest>,
) {
	await requireOwnedProject(caller.userId, request.projectId);
	return saveImportedProjectSecrets({
		userId: caller.userId,
		projectId: request.projectId,
		variables: importedSecretValues(request.variables),
	});
}

/** One session's handoff; its transcript follows with PUT transcript?session=<id>. */
export async function importSession(
	caller: ImportCaller,
	request: z.infer<typeof sessionUploadRequest>,
) {
	await requireOwnedProject(caller.userId, request.projectId);
	const handoff = request.handoff;
	const bytes = new TextEncoder().encode(JSON.stringify(handoff));
	const saved = await saveImportedSession({
		id: randomUUID(),
		importId: caller.importId,
		userId: caller.userId,
		projectId: request.projectId,
		tool: handoff.tool,
		sourceSessionId: handoff.sessionId,
		title: handoff.title ?? "",
		turnCount: handoff.totalTurns,
		sourceStartedAt: handoff.startedAt ?? null,
		sourceUpdatedAt: handoff.updatedAt,
		handoffBytes: bytes.byteLength,
	});
	if (!saved) return refuse("Project is not available.", 404);
	await storeHandoffObject(
		{ userId: caller.userId, projectId: saved.projectId },
		saved.id,
		"handoff.json",
		bytes,
	);
	await saveLocalImportProgress(caller.importId, {
		status: "importing",
		importedOne: true,
		sessionsPlanned: request.total,
	});
	return {
		importedSessionId: saved.id,
		transcriptUpload: `/api/local-import/transcript?session=${saved.id}`,
	};
}

/** The session's full transcript: a gzip tar of transcript.md and its images. */
export async function importTranscript(
	caller: ImportCaller,
	importedSessionId: string,
	archive: Uint8Array,
) {
	if (!looksGzipped(archive))
		refuse("Send the transcript as a gzip archive (application/gzip).", 415);
	const session = await importedSessionOfImport(
		caller.userId,
		caller.importId,
		importedSessionId,
	);
	if (!session) return refuse("Upload this session's handoff first.", 404);
	await storeHandoffObject(
		{ userId: caller.userId, projectId: session.projectId },
		session.id,
		"transcript.tgz",
		archive,
	);
	await saveImportedTranscriptSize(
		caller.userId,
		session.id,
		archive.byteLength,
	);
	return { stored: archive.byteLength };
}

export type FinishDependencies = {
	readonly branchExists: (
		userId: string,
		fullName: string,
		branch: string,
	) => Promise<boolean>;
};

const defaultFinishDependencies: FinishDependencies = {
	branchExists: async (userId, fullName, branch) =>
		Boolean(
			await repositoryBranchSha(
				await githubAccessToken(userId),
				fullName,
				branch,
			),
		),
};

function chatTitle(title: string | undefined, agent: string) {
	const text = title?.replace(/\s+/g, " ").trim();
	return (text ? text : `Continued from ${agent}`).slice(0, 80);
}

function openUrl(projectId: string, sessionId: string) {
	return `${serverConfig().APP_URL}/?project=${projectId}&chat=${sessionId}`;
}

/**
 * The continued repository's handoff chat, on the branch the CLI pushed:
 * its first item is the handoff (a compact card; the model reads the whole
 * handoff), and no turn starts, so the chat waits for the user. A draft
 * environment setup from the session's successful commands is saved
 * (imported, unverified) when the repository has none, and the project's
 * environment is prepared.
 */
export async function finishImport(
	caller: ImportCaller,
	request: z.infer<typeof finishRequest>,
	dependencies: FinishDependencies = defaultFinishDependencies,
) {
	// A repeated finish (its reply was lost) returns the chat it made.
	if (
		caller.row.status === "ready" &&
		caller.row.sessionId &&
		caller.row.projectId
	)
		return {
			projectId: caller.row.projectId,
			sessionId: caller.row.sessionId,
			openUrl: openUrl(caller.row.projectId, caller.row.sessionId),
		};
	if (caller.row.status === "ready")
		refuse("This import already finished.", 409);
	const project = await requireOwnedProject(caller.userId, request.projectId);
	const branch = handoffBranch(request.branch);
	if (!branch) refuse("The branch must be a valid ytimesy/... branch.", 400);
	const repositories = repositoriesForProject(project);
	const repository =
		repositories.length === 1
			? repositories[0]
			: repositories.find(
					(repo) =>
						repo.fullName.toLowerCase() === request.repository?.toLowerCase(),
				);
	if (!repository)
		return refuse(
			`Name the repository: one of ${repositories.map((repo) => repo.fullName).join(", ")}.`,
			400,
		);
	if (
		!(await dependencies.branchExists(
			caller.userId,
			repository.fullName,
			branch as string,
		))
	)
		refuse(`Push ${branch} to ${repository.fullName} first.`, 409);
	const imported = await importedSessionBySource({
		userId: caller.userId,
		projectId: project.id,
		tool: request.continue.tool,
		sourceSessionId: request.continue.sessionId,
	});
	if (!imported) return refuse("Upload the session to continue first.", 409);
	const stored = await readHandoffObject(
		{ userId: caller.userId, projectId: project.id },
		imported.id,
		"handoff.json",
	);
	if (!stored) return refuse("Upload the session to continue first.", 409);
	const handoff = handoffDocument.parse(
		JSON.parse(new TextDecoder().decode(stored)),
	);

	// Setup first, so a project whose environment is prepared below builds with it.
	const recipe = draftEnvironmentRecipe(handoff.successfulCommands);
	if (recipe) {
		const saved = await latestEnvironmentRecipes(caller.userId, project.id);
		if (!saved.has(repository.repositoryId))
			await saveProjectEnvironment({
				userId: caller.userId,
				projectId: project.id,
				repository: repository.fullName,
				recipe,
				source: "import",
				summary: `Imported from a ${handoff.tool} session; unverified.`,
			}).catch((error) => {
				// The chat still opens; the user can set up the environment.
				console.warn("Imported environment setup was not saved.", {
					message: (error as Error).message,
				});
			});
	}
	let workspace = await workspaceForProject(caller.userId, project.id);
	if (!workspace || workspace.status === "failed") {
		const queued = await Effect.runPromise(
			Effect.either(enqueueProjectWorkspace(caller.userId, project.id)),
		);
		if (queued._tag === "Left") throw queued.left.error;
		workspace = queued.right;
	}
	if (!workspace)
		return refuse("The project's environment is not available.", 503);

	const chats = await listAgentSessions(caller.userId, project.id);
	const reference = chats.find((chat) => !chat.parentSessionId);
	const agentName = LOCAL_AGENT_NAMES[handoff.tool];
	const chat = await insertAgentSession({
		userId: caller.userId,
		projectId: project.id,
		workspaceId: workspace.id,
		harness: reference?.harness ?? DEFAULT_COMPOSER_HARNESS_ID,
		title: chatTitle(handoff.title, agentName),
		listedModelId: reference?.listedModelId ?? null,
	});
	await saveSessionWorkingBranch(
		caller.userId,
		chat.id,
		branch as string,
		repository.branch,
	);
	const item: HandoffSessionItem = {
		kind: "handoff",
		id: SessionItemId(`handoff-${imported.id}`),
		tool: handoff.tool,
		title: handoff.title ?? "",
		turns: handoff.totalTurns,
		at: handoff.updatedAt,
		context: handoffContextText(handoff),
	};
	await saveAgentSessionItems(chat.id, [item]);
	await saveLocalImportProgress(caller.importId, {
		status: "ready",
		projectId: project.id,
		sessionId: chat.id,
		message: `${request.pushedFiles} ${request.pushedFiles === 1 ? "file" : "files"} pushed, ${request.skippedFiles} skipped.`,
	});
	return {
		projectId: project.id,
		sessionId: chat.id,
		openUrl: openUrl(project.id, chat.id),
		handoffDirectory: HANDOFF_DIRECTORY,
	};
}
