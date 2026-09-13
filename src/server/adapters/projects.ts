import { randomUUID } from "node:crypto";
import type { Project, RepositoryChoice } from "../../domain/projects";
import { database } from "./database";
export async function listProjects(userId: string): Promise<Project[]> {
	const result = await database().query(
		'select id,repository_id::float8 as "repositoryId",installation_id::float8 as "installationId",full_name as "fullName",branch from project where user_id=$1 order by created_at',
		[userId],
	);
	return result.rows;
}
export async function saveProject(
	userId: string,
	repository: RepositoryChoice,
	branch: string,
): Promise<Project> {
	const result = await database().query(
		'insert into project(id,user_id,repository_id,installation_id,full_name,branch) values($1,$2,$3,$4,$5,$6) on conflict(user_id,repository_id) do update set installation_id=excluded.installation_id,full_name=excluded.full_name,branch=excluded.branch returning id,repository_id::float8 as "repositoryId",installation_id::float8 as "installationId",full_name as "fullName",branch',
		[
			randomUUID(),
			userId,
			repository.repositoryId,
			repository.installationId,
			repository.fullName,
			branch,
		],
	);
	return result.rows[0];
}
