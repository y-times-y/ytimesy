import { randomUUID } from "node:crypto";
import type {
	Project,
	ProjectRepository,
	RepositoryChoice,
} from "../../domain/projects";
import { database } from "./database";

const projectColumns = `p.id,p.name,p.repository_id::float8 as "repositoryId",p.installation_id::float8 as "installationId",p.full_name as "fullName",p.branch,p.machine_size as "machineSize",
  (select json_agg(json_build_object('repositoryId',r.repository_id::float8,'installationId',r.installation_id::float8,'fullName',r.full_name,'branch',r.branch) order by r.position)
   from project_repository r where r.project_id=p.id) as repositories`;
export async function listProjects(userId: string): Promise<Project[]> {
	const result = await database().query(
		`select ${projectColumns} from project p where p.user_id=$1 and p.archived_at is null order by p.created_at`,
		[userId],
	);
	return result.rows.map(projectFromRow);
}
export async function projectForOwner(
	userId: string,
	projectId: string,
): Promise<Project | null> {
	const result = await database().query(
		`select ${projectColumns} from project p where p.id=$1 and p.user_id=$2`,
		[projectId, userId],
	);
	return result.rows[0] ? projectFromRow(result.rows[0]) : null;
}

function projectFromRow(row: Project): Project {
	if (row.name) return row;
	const { name: _name, repositories: _repositories, ...legacy } = row;
	return legacy;
}

/** One statement commits the project and its complete, pre-authorized repository set. */
export async function saveProjectGroup(
	userId: string,
	name: string,
	repositories: ProjectRepository[],
): Promise<Project> {
	const primary = repositories[0];
	if (!primary) throw new Error("Select at least one repository.");
	const id = randomUUID();
	await database().query(
		`with saved as (
    insert into project(id,user_id,repository_id,installation_id,full_name,branch,name,repository_set_key)
    values($1,$2,$3,$4,$5,$6,$7,$9) returning id
  ) insert into project_repository(project_id,repository_id,installation_id,full_name,branch,position)
    select saved.id,r."repositoryId",r."installationId",r."fullName",r.branch,r.position
    from saved,jsonb_to_recordset($8::jsonb) as r("repositoryId" bigint,"installationId" bigint,"fullName" text,branch text,position integer)`,
		[
			id,
			userId,
			primary.repositoryId,
			primary.installationId,
			primary.fullName,
			primary.branch,
			name,
			JSON.stringify(
				repositories.map((repo, position) => ({ ...repo, position })),
			),
			id,
		],
	);
	const project = await projectForOwner(userId, id);
	if (!project) throw new Error("Project could not be saved.");
	return project;
}
/**
 * Refreshes the GitHub access of a project's repository (installation, name,
 * branch) on the project and its repository row, and renames the project
 * when `name` is given. Used when a repository is added again.
 */
export async function refreshProjectRepository(
	userId: string,
	projectId: string,
	repository: ProjectRepository,
	name: string | null,
): Promise<Project> {
	await database().query(
		`with refreshed as (
    update project set installation_id=$3,full_name=$4,branch=$5,name=coalesce($6,name)
    where id=$1 and user_id=$7 and repository_id=$2 returning id
  ) update project_repository r set installation_id=$3,full_name=$4,branch=$5
    from refreshed where r.project_id=refreshed.id and r.repository_id=$2`,
		[
			projectId,
			repository.repositoryId,
			repository.installationId,
			repository.fullName,
			repository.branch,
			name,
			userId,
		],
	);
	const project = await projectForOwner(userId, projectId);
	if (!project)
		throw new Response("Project is not available.", { status: 404 });
	return project;
}
/**
 * A project saved on an agent's own `ytimesy/` branch (from before new
 * projects refused them) takes the repository's default, read from GitHub.
 * The new-chat picker then renders it from the first paint instead of
 * swapping once GitHub answers. Returns how many rows changed.
 */
export async function healGeneratedProjectBranches(
	userId: string,
	repositoryId: number,
	defaultBranch: string,
): Promise<number> {
	const result = await database().query(
		`with healed as (
    update project_repository r set branch=$3
    from project p
    where r.project_id=p.id and p.user_id=$1 and r.repository_id=$2
      and (r.branch='ytimesy' or r.branch like 'ytimesy/%')
    returning r.project_id
  ) update project set branch=$3
    where user_id=$1 and repository_id=$2 and (branch='ytimesy' or branch like 'ytimesy/%')`,
		[userId, repositoryId, defaultBranch],
	);
	return result.rowCount ?? 0;
}
export async function projectForRepository(
	userId: string,
	repositoryId: number,
): Promise<Project | null> {
	const result = await database().query(
		'select id,repository_id::float8 as "repositoryId",installation_id::float8 as "installationId",full_name as "fullName",branch from project where user_id=$1 and repository_id=$2 and repository_set_key=\'\'',
		[userId, repositoryId],
	);
	return result.rows[0] ?? null;
}
/**
 * Connects a repository as a project. A repository the person removed before
 * (an archived project) is restored, chats and all: saving it again returns the
 * same project, which then shows in the project list (it was left archived, so
 * the list hid it and the composer fell back to the first project).
 */
export async function saveProject(
	userId: string,
	repository: RepositoryChoice,
	branch: string,
): Promise<Project> {
	const result = await database().query(
		'insert into project(id,user_id,repository_id,installation_id,full_name,branch) values($1,$2,$3,$4,$5,$6) on conflict(user_id,repository_id,repository_set_key) do update set installation_id=excluded.installation_id,full_name=excluded.full_name,branch=excluded.branch,archived_at=null returning id,repository_id::float8 as "repositoryId",installation_id::float8 as "installationId",full_name as "fullName",branch',
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

export async function deleteProjectForOwner(userId: string, projectId: string) {
	const result = await database().query(
		"delete from project where id=$1 and user_id=$2 returning id",
		[projectId, userId],
	);
	if (!result.rows[0])
		throw new Response("Project is not available.", { status: 403 });
}
