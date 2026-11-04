import { z } from "zod";
import { readBoundedRequestBody } from "../../domain/bounded-request-body";
import {
	GIT_GRANT_USERNAME,
	gitGrantPassword,
	issueMachineGitGrant,
	type MachineGitAccess,
	type MachineGitGrant,
	type MachineGitHooks,
	type RefUpdate,
	repositoryPart,
} from "../../domain/github-git-proxy";
import { MACHINE_GIT_GRANT_ROUTE } from "../../domain/machine-git";
import { database } from "../adapters/database";
import { projectAllowsDefaultBranchPush } from "../adapters/default-branch-push";
import { gitPushRequests } from "../adapters/git-push-requests";
import { authorizedGithubRepository } from "../adapters/github";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import {
	type MachineGitChat,
	type MachineGitTokenOwner,
	machineGitTokens,
} from "../adapters/machine-git-tokens";
import { githubAccessToken } from "../auth/github-connection";
import { timed } from "../services/step-timing";

/** Where plain git on a chat's VM (its credential helper) asks for a grant. */
export const MACHINE_GIT_GRANT_PATH = MACHINE_GIT_GRANT_ROUTE;

const grantRequest = z
	.object({
		owner: repositoryPart.max(100),
		name: repositoryPart.max(100),
		access: z.enum(["read", "write"]),
		branch: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[^\s\0~^:?*[\\]+$/)
			.optional(),
	})
	.strict();
type GrantRequest = z.infer<typeof grantRequest>;

/** A repository as the chat's owner sees it on GitHub. */
export type VisibleRepository = {
	private: boolean;
	defaultBranch: string;
	push: boolean;
};

/** The reads behind a machine's git access, injectable for tests. */
export type MachineGitSources = {
	/** The chat is still there, its owner's, in this project, not archived. */
	chatIsLive(chat: MachineGitChat): Promise<boolean>;
	/** The chat's project repository with this full name (any case), else null. */
	projectRepository(
		chat: MachineGitChat,
		fullName: string,
	): Promise<{ installationId: number; fullName: string } | null>;
	/** The owner's GitHub token; throws when GitHub is not connected. */
	githubToken(userId: string): Promise<string>;
	/** The repository as the user's token sees it; null when they cannot. */
	repository(
		userToken: string,
		owner: string,
		name: string,
	): Promise<VisibleRepository | null>;
	/** An installation token for one repository; throws when the installation cannot reach it. */
	installationToken(
		installationId: number,
		name: string,
		access: "read" | "write",
	): Promise<string>;
	projectAllowsDefaultBranchPush(
		userId: string,
		projectId: string,
	): Promise<boolean>;
};

export class MachineGitRefusal extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
	}
}

/** What a chat's git may do with one repository, and how the proxy reaches it. */
export type ResolvedMachineAccess = MachineGitAccess & {
	owner: string;
	name: string;
	installationId?: number;
};

/**
 * Decides one repository access for a chat, with the reason the agent reads
 * when refused. Reads: the project's repositories, and public ones
 * (anonymously); no other private repository, even one the user's
 * installation reaches. Writes: the project's repositories only, with the
 * user's own push permission.
 */
export async function resolveMachineAccess(
	chat: MachineGitChat,
	input: Pick<GrantRequest, "owner" | "name" | "access">,
	sources: MachineGitSources,
): Promise<ResolvedMachineAccess> {
	const repo = `${input.owner}/${input.name}`;
	const [live, project] = await Promise.all([
		sources.chatIsLive(chat),
		sources.projectRepository(chat, repo),
	]);
	if (!live)
		throw new MachineGitRefusal(
			401,
			"This chat's workspace credentials are no longer valid.",
		);
	if (input.access === "write" && !project)
		throw new MachineGitRefusal(
			403,
			`Pushes from this workspace go only to this project's repositories; ${repo} is not one of them.`,
		);
	const userToken = await sources.githubToken(chat.userId).catch(() => {
		throw new MachineGitRefusal(
			403,
			"GitHub is not connected; the user can reconnect it in ytimesy.",
		);
	});
	const [projectOwner, projectName] = project
		? project.fullName.split("/")
		: [input.owner, input.name];
	const visible = await sources.repository(
		userToken,
		projectOwner,
		projectName,
	);
	if (!visible)
		throw new MachineGitRefusal(
			403,
			`${repo} was not found, or the user's GitHub account cannot see it.`,
		);
	if (input.access === "write" && !visible.push)
		throw new MachineGitRefusal(
			403,
			`The user's GitHub account cannot push to ${repo}.`,
		);
	const resolved = {
		owner: projectOwner,
		name: projectName,
		defaultBranch: visible.defaultBranch,
	};
	if (!project) {
		if (visible.private)
			throw new MachineGitRefusal(
				403,
				`${repo} is not in this project; add it to the project to use it here.`,
			);
		return { ...resolved, token: null };
	}
	const token = await sources
		.installationToken(project.installationId, projectName, input.access)
		.catch(() => null);
	if (token)
		return { ...resolved, installationId: project.installationId, token };
	if (input.access === "read" && !visible.private)
		return { ...resolved, token: null };
	throw new MachineGitRefusal(
		403,
		`The ytimesy GitHub App cannot reach ${repo}; the user can add it to the app's installation on ${projectOwner}.`,
	);
}

/** The proxy's per-operation checks for a machine grant: the same decision, the same installation. */
export function machineGitHooks(sources: MachineGitSources): MachineGitHooks {
	return {
		async authorize(grant: MachineGitGrant) {
			try {
				const access = await resolveMachineAccess(grant, grant, sources);
				return access.installationId === grant.installationId ? access : null;
			} catch (cause) {
				if (cause instanceof MachineGitRefusal) return null;
				throw cause;
			}
		},
		async defaultBranchPush(grant: MachineGitGrant, update: RefUpdate) {
			const push = {
				userId: grant.userId,
				projectId: grant.projectId,
				owner: grant.owner,
				name: grant.name,
				branch: update.ref.slice("refs/heads/".length),
			};
			if (
				(await sources.projectAllowsDefaultBranchPush(
					grant.userId,
					grant.projectId,
				)) ||
				(await gitPushRequests.claimApproved({ ...push, newId: update.newId }))
			)
				return true;
			await gitPushRequests.recordRefused({
				...push,
				sessionId: grant.sessionId,
				oldId: update.oldId,
				newId: update.newId,
			});
			return false;
		},
	};
}

function refusal(status: number, error: string) {
	return Response.json(
		{ error },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

/**
 * The machine token in, a short-lived signed grant out, as the Basic
 * credentials plain git sends the proxy. Refusals carry the reason the
 * credential helper prints for the agent.
 */
export async function answerMachineGitGrant(
	request: Request,
	secret: string,
	sources: MachineGitSources,
	tokenOwner: (token: string) => Promise<MachineGitTokenOwner | null> = (
		token,
	) => machineGitTokens.owner(token),
) {
	if (request.method !== "POST") return new Response(null, { status: 404 });
	const bearer = /^Bearer (\S{1,200})$/.exec(
		request.headers.get("authorization") ?? "",
	);
	const chat = bearer ? await tokenOwner(bearer[1]) : null;
	if (!chat)
		return refusal(
			401,
			"This workspace's git credentials expired; they renew on the agent's next step.",
		);
	let input: GrantRequest;
	try {
		input = grantRequest.parse(
			JSON.parse(await readBoundedRequestBody(request, 1024)),
		);
	} catch {
		return refusal(400, "Malformed git grant request.");
	}
	try {
		const access = await timed("git:machineGrant", () =>
			resolveMachineAccess(chat, input, sources),
		);
		const headers = await issueMachineGitGrant(secret, {
			userId: chat.userId,
			sessionId: chat.sessionId,
			projectId: chat.projectId,
			owner: input.owner,
			name: input.name,
			...(access.installationId
				? { installationId: access.installationId }
				: {}),
			access: input.access,
			...(chat.holder === "terminal" ? { holder: "terminal" as const } : {}),
			...(input.access === "write" && input.branch
				? { branch: input.branch }
				: {}),
		});
		return Response.json(
			{ username: GIT_GRANT_USERNAME, password: gitGrantPassword(headers) },
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (cause) {
		if (cause instanceof MachineGitRefusal)
			return refusal(cause.status, cause.message);
		console.warn("Machine git grant failed.", {
			error: cause instanceof Error ? cause.name : "unknown",
		});
		return refusal(503, "ytimesy's git service is unavailable; try again.");
	}
}

/** The production reads: the database, the user's GitHub token and the app's installations. */
export const machineGitSources: MachineGitSources = {
	async chatIsLive(chat) {
		const result = await database().query(
			"select 1 from agent_session where id=$1 and user_id=$2 and project_id=$3 and archived_at is null",
			[chat.sessionId, chat.userId, chat.projectId],
		);
		return result.rows.length === 1;
	},
	async projectRepository(chat, fullName) {
		const result = await database().query<{
			installationId: number;
			fullName: string;
		}>(
			`select r.installation_id::float8 as "installationId", r.full_name as "fullName"
			 from project_repository r join project p on p.id=r.project_id
			 where p.id=$1 and p.user_id=$2 and lower(r.full_name)=lower($3)
			 limit 1`,
			[chat.projectId, chat.userId, fullName],
		);
		return result.rows[0] ?? null;
	},
	githubToken: (userId) => githubAccessToken(userId),
	repository: (userToken, owner, name) =>
		timed("git:reposGet", () =>
			authorizedGithubRepository(userToken, owner, name),
		),
	installationToken: (installationId, name, access) =>
		timed("git:installationToken", () =>
			githubInstallationAccessToken(installationId, {
				repositoryNames: [name],
				contents: access,
			}),
		),
	projectAllowsDefaultBranchPush,
};
