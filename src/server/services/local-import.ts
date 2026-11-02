import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { z } from "zod";
import { addedProjectBranch } from "#/domain/add-project";
import { DEFAULT_COMPOSER_HARNESS_ID } from "#/domain/agent-provider";
import { handoffSummary } from "#/domain/handoff-summary";
import { SessionItemId } from "#/domain/ids";
import {
	bearerImportToken,
	type createProjectRequest,
	draftEnvironmentRecipe,
	type FinishedImportView,
	type finishRequest,
	HANDOFF_DIRECTORY,
	handoffBranch,
	handoffContextText,
	handoffDocument,
	handoffFolderName,
	IMPORT_CANCELLED_MESSAGE,
	IMPORT_CODE_TTL_MS,
	IMPORT_TOKEN_TTL_MS,
	importCodeRefusal,
	importedSecretValues,
	importSecretHash,
	importTokenUsable,
	LOCAL_AGENT_NAMES,
	LOCAL_AGENTS,
	type LocalAgent,
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
	type RepositoryChoice,
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
	listAuthorizedRepositories,
	repositoryBranchSha,
} from "../adapters/github";
import {
	readHandoffObject,
	storeHandoffObject,
} from "../adapters/handoff-store";
import {
	cancelLocalImportRow,
	finishedLocalImports,
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
import {
	listProjects,
	projectForOwner,
	projectForRepository,
	saveProject,
} from "../adapters/projects";
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
import { connectProject } from "./projects";
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
		prompt: localImportPrompt(code, serverConfig().APP_URL),
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
		agent: (LOCAL_AGENTS as readonly string[]).includes(row.agent ?? "")
			? (row.agent as LocalAgent)
			: null,
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

/**
 * The card's Cancel (by the owner) or `ytimesy continue --cancel` (by the
 * token): an unfinished import stops, so the card stops waiting. A finished
 * import is left as it is.
 */
export async function cancelLocalImport(userId: string, importId: string) {
	const cancelled = await cancelLocalImportRow(
		userId,
		importId,
		IMPORT_CANCELLED_MESSAGE,
	);
	if (cancelled) return localImportView(cancelled);
	return localImportStatus(userId, importId);
}

/** Settings > Import: the user's finished imports, newest first. */
export async function listFinishedImports(
	userId: string,
): Promise<FinishedImportView[]> {
	const rows = await finishedLocalImports(userId);
	return rows.map((row) => ({
		id: row.id,
		finishedAt: new Date(row.finishedAt).toISOString(),
		agent: (LOCAL_AGENTS as readonly string[]).includes(row.agent ?? "")
			? (row.agent as LocalAgent)
			: null,
		sessions: row.sessionsImported,
		projectId: row.projectId,
		projectName: projectDisplayName({
			name: row.projectName ?? undefined,
			fullName: row.projectFullName,
		}),
		sessionId: row.sessionId,
	}));
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
				: row.status === "failed" && row.message
					? `${row.message} Copy a new prompt in ytimesy.`
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

function installationUrl() {
	return `https://github.com/apps/${serverConfig().GITHUB_APP_SLUG}/installations/new`;
}

/**
 * Spends the code and returns the token and the user's projects. ytimesy
 * never creates repositories (its GitHub app lacks the Administration
 * permission): the CLI does, with the user's own GitHub login.
 */
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
	const projects = await listProjects(row.userId);
	return {
		token,
		expiresAt: tokenExpiresAt.toISOString(),
		appUrl: serverConfig().APP_URL,
		projects: planProjects(projects),
	};
}

/** For each folder of local sessions: where it goes, or what the user must decide. */
export async function planImport(caller: ImportCaller, request: PlanRequest) {
	const githubToken = await githubAccessToken(caller.userId);
	const [projects, reachable] = await Promise.all([
		listProjects(caller.userId),
		listAuthorizedRepositories(githubToken),
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
			installationUrl: installationUrl(),
		}),
	};
}

export type ImportProjectDependencies = {
	readonly reachable: (userId: string) => Promise<readonly RepositoryChoice[]>;
	readonly branchExists: (
		userId: string,
		fullName: string,
		branch: string,
	) => Promise<boolean>;
	readonly projectForRepository: (
		userId: string,
		repositoryId: number,
	) => Promise<Project | null>;
	/** A project for a repository with commits; its environment is prepared. */
	readonly connect: (
		userId: string,
		repository: RepositoryChoice,
	) => Promise<Project>;
	/** A project for an empty repository; finish prepares it once the push landed. */
	readonly save: (
		userId: string,
		repository: RepositoryChoice,
	) => Promise<Project>;
};

const defaultImportProjectDependencies: ImportProjectDependencies = {
	reachable: async (userId) =>
		listAuthorizedRepositories(await githubAccessToken(userId)),
	branchExists: async (userId, fullName, branch) =>
		Boolean(
			await repositoryBranchSha(
				await githubAccessToken(userId),
				fullName,
				branch,
			),
		),
	projectForRepository,
	connect: async (userId, repository) => {
		const result = await Effect.runPromise(
			Effect.either(
				connectProject(userId, {
					installationId: repository.installationId,
					repositoryId: repository.repositoryId,
					branch: addedProjectBranch(repository),
				}),
			),
		);
		if (result._tag === "Left") throw result.left.error;
		return result.right;
	},
	save: (userId, repository) =>
		saveProject(userId, repository, addedProjectBranch(repository)),
};

/**
 * Makes a project of a GitHub repository the ytimesy app reaches: one the
 * plan found without a project, or one the CLI just created with the user's
 * own `gh` login. The same repository twice returns its project. A
 * repository the app cannot see yet (an install on selected repositories)
 * is refused with the link to add it there; nothing is created here.
 */
export async function createImportProject(
	caller: ImportCaller,
	request: z.infer<typeof createProjectRequest>,
	dependencies: ImportProjectDependencies = defaultImportProjectDependencies,
) {
	await requireUserAction(caller.userId, "project-create");
	const wanted = request.repository.toLowerCase();
	const repository = (await dependencies.reachable(caller.userId)).find(
		(candidate) => candidate.fullName.toLowerCase() === wanted,
	);
	if (!repository)
		return refuse(
			`The ytimesy GitHub app cannot see ${request.repository} yet. Add it to the app's repositories at ${installationUrl()}, then re-run.`,
			409,
		);
	const existing = await dependencies.projectForRepository(
		caller.userId,
		repository.repositoryId,
	);
	// A new repository has no commits yet: the CLI pushes its first, and
	// finish prepares the environment then.
	const project =
		existing ??
		((await dependencies.branchExists(
			caller.userId,
			repository.fullName,
			repository.defaultBranch,
		))
			? await dependencies.connect(caller.userId, repository)
			: await dependencies.save(caller.userId, repository));
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
		branch: branch as string,
		summary: handoffSummary(handoff, {
			transcript: `${HANDOFF_DIRECTORY}/${handoffFolderName(handoff.tool, handoff.sessionId)}/transcript.md`,
		}),
		files: {
			pushed: request.pushedPaths,
			pushedCount: Math.max(request.pushedFiles, request.pushedPaths.length),
			skipped: request.skippedPaths,
			skippedCount: Math.max(request.skippedFiles, request.skippedPaths.length),
		},
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
