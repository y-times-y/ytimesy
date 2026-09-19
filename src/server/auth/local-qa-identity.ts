import {
	authGetSessionPath,
	localQaIdentityAllowed,
	preferLocalQaUser,
} from "#/domain/local-qa-identity";
import { database } from "../adapters/database";

export type LocalQaUser = {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	readonly emailVerified: boolean;
	readonly image: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
};

export function requestAllowsLocalQaIdentity(headers: Headers) {
	return localQaIdentityAllowed({
		nodeEnv: process.env.NODE_ENV,
		host: headers.get("host") ?? undefined,
	});
}

export async function loadLocalQaUser(): Promise<LocalQaUser | null> {
	const result = await database().query<{
		id: string;
		name: string;
		email: string;
		emailVerified: boolean;
		image: string | null;
		createdAt: Date;
		updatedAt: Date;
		github: boolean;
		hasProject: boolean;
		lastSessionAt: Date | null;
	}>(
		`select
			u.id,
			u.name,
			u.email,
			u."emailVerified",
			u.image,
			u."createdAt",
			u."updatedAt",
			exists(
				select 1 from auth_account a
				where a."userId" = u.id and a."providerId" = 'github'
			) as github,
			exists(select 1 from project p where p.user_id = u.id) as "hasProject",
			(
				select max(s."createdAt") from auth_session s where s."userId" = u.id
			) as "lastSessionAt"
		from auth_user u`,
	);
	const chosen = preferLocalQaUser(
		result.rows.map((row) => ({
			id: row.id,
			github: row.github,
			hasProject: row.hasProject,
			lastSessionAt: row.lastSessionAt?.toISOString() ?? null,
		})),
	);
	if (!chosen) return null;
	const user = result.rows.find((row) => row.id === chosen.id);
	if (!user) return null;
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		emailVerified: user.emailVerified,
		image: user.image,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

export async function withLocalQaSession(request: Request, response: Response) {
	if (!requestAllowsLocalQaIdentity(request.headers)) return response;
	if (!authGetSessionPath(new URL(request.url).pathname)) return response;
	const payload = (await response
		.clone()
		.json()
		.catch(() => null)) as { user?: unknown } | null;
	if (payload?.user) return response;
	const user = await loadLocalQaUser();
	if (!user) return response;
	return Response.json(
		{
			user,
			session: {
				id: "local-qa",
				userId: user.id,
				expiresAt: new Date(Date.now() + 60 * 60 * 24 * 7),
				createdAt: user.createdAt,
				updatedAt: user.updatedAt,
			},
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
