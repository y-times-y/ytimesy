import { TEST_ACCOUNT_ID } from "#/domain/test-account";
import {
	sessionSlugMatch,
	uuidSlugMatch,
} from "../adapters/freestyle/slug-sql";
import type { TestAccountDb } from "./test-account";

export type VmMapping = {
	slug: string;
	kind: "chat" | "build" | "workspace" | "unreferenced";
	owner: "test" | "real" | "none";
	chatArchived: boolean | null;
	projectArchived: boolean | null;
	idleDays: number | null;
	buildStatus: string | null;
};

/**
 * Read-only: what database row (if any) each machine slug belongs to, as
 * labels and counts. No ids of users, projects or chats, no content.
 */
export async function mapVmSlugs(
	db: TestAccountDb,
	slugs: readonly string[],
): Promise<VmMapping[]> {
	const out: VmMapping[] = [];
	for (const slug of slugs.slice(0, 300)) {
		const chat = (
			await db.query<{
				user_id: string;
				archived: boolean;
				project_archived: boolean;
				idle: string;
			}>(
				`select s.user_id, s.archived_at is not null as archived, p.archived_at is not null as project_archived,
				  extract(epoch from (now()-s.updated_at))/86400 as idle
				 from agent_session s join project p on p.id=s.project_id where ${sessionSlugMatch("$1", "s.id")}`,
				[slug],
			)
		).rows[0];
		if (chat) {
			out.push({
				slug,
				kind: "chat",
				owner: chat.user_id === TEST_ACCOUNT_ID ? "test" : "real",
				chatArchived: chat.archived,
				projectArchived: chat.project_archived,
				idleDays: Math.round(Number(chat.idle) * 10) / 10,
				buildStatus: null,
			});
			continue;
		}
		const build = (
			await db.query<{
				user_id: string;
				status: string;
				idle: string;
				project_archived: boolean;
			}>(
				`select w.user_id, b.status, extract(epoch from (now()-b.created_at))/86400 as idle, p.archived_at is not null as project_archived
				 from environment_build b join workspace w on w.id=b.workspace_id join project p on p.id=w.project_id
				 where ${uuidSlugMatch("$1", "ytimesy-build-", "b.id")}`,
				[slug],
			)
		).rows[0];
		if (build) {
			out.push({
				slug,
				kind: "build",
				owner: build.user_id === TEST_ACCOUNT_ID ? "test" : "real",
				chatArchived: null,
				projectArchived: build.project_archived,
				idleDays: Math.round(Number(build.idle) * 10) / 10,
				buildStatus: build.status,
			});
			continue;
		}
		const workspace = (
			await db.query<{ user_id: string; project_archived: boolean }>(
				`select w.user_id, p.archived_at is not null as project_archived from workspace w join project p on p.id=w.project_id where ${uuidSlugMatch("$1", "ytimesy-ws-", "w.id")}`,
				[slug],
			)
		).rows[0];
		out.push(
			workspace
				? {
						slug,
						kind: "workspace",
						owner: workspace.user_id === TEST_ACCOUNT_ID ? "test" : "real",
						chatArchived: null,
						projectArchived: workspace.project_archived,
						idleDays: null,
						buildStatus: null,
					}
				: {
						slug,
						kind: "unreferenced",
						owner: "none",
						chatArchived: null,
						projectArchived: null,
						idleDays: null,
						buildStatus: null,
					},
		);
	}
	return out;
}
