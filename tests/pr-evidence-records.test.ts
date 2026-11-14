import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { evidenceManifest } from "../src/domain/pr-evidence";
import {
	deleteEvidenceRows,
	evidenceForOwner,
	evidenceOfClosedPulls,
	evidenceOfOwner,
	evidenceRepositories,
	expiredEvidence,
	failStaleCaptures,
	finishEvidence,
	insertCapturingEvidence,
	supersededEvidence,
} from "../src/server/adapters/pr-evidence-records";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));

const project = "00000000-0000-4000-8000-000000000001";
const otherProject = "00000000-0000-4000-8000-000000000011";
const workspace = "00000000-0000-4000-8000-000000000002";
const session = "00000000-0000-4000-8000-000000000003";
const id = (n: number) =>
	`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const sha = "c3c0528b5e6e62912fb34a066cf13a9fb81eb770";

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());
beforeEach(async () => {
	await db.exec(`
		delete from infrastructure_provider_statement; delete from infrastructure_vm_admission; delete from infrastructure_usage_reservation;
		delete from auth_user;
		insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true);
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('${project}','alice',1,2,'owner/app','main'),('${otherProject}','alice',3,2,'owner/other','main');
		insert into workspace(id,user_id,project_id,status) values('${workspace}','alice','${project}','ready');
		insert into agent_session(id,user_id,project_id,workspace_id,harness,status) values('${session}','alice','${project}','${workspace}','codex','ready');
	`);
});

const capture = (n: number, pullNumber = 7) =>
	insertCapturingEvidence({
		id: id(n),
		userId: "alice",
		projectId: project,
		sessionId: session,
		installationId: 2,
		fullName: "owner/app",
		pullNumber,
		commitSha: sha,
		planKey: "auto-abc",
		kind: "web",
	});

const manifest = evidenceManifest.parse({
	version: 1,
	mode: "verify",
	kind: "web",
	status: "captured",
	sha,
	clean: true,
	startCommand: "pnpm dev",
	startSource: "auto",
	urls: ["http://localhost:5173/"],
	video: { file: "recording.webm", seconds: 6 },
	browser: "Chrome 155 headless, Playwright 1.63.0",
	startedAt: "2026-10-18T16:45:11Z",
	finishedAt: "2026-10-18T16:45:17Z",
});
const files = [
	{ name: "01-home.png", bytes: 10, sha256: "a".repeat(64) },
	{ name: "recording.webm", bytes: 20, sha256: "b".repeat(64) },
];

describe("pr_evidence rows", () => {
	it("records a capture and shows it only to the project's owner", async () => {
		await capture(1);
		expect((await evidenceForOwner("alice", project, id(1)))?.status).toBe(
			"capturing",
		);
		await finishEvidence("alice", id(1), { manifest, headSha: sha, files });
		const record = await evidenceForOwner("alice", project, id(1));
		expect(record).toMatchObject({
			id: id(1),
			projectId: project,
			sessionId: session,
			fullName: "owner/app",
			pullNumber: 7,
			commitSha: sha,
			headSha: sha,
			status: "captured",
			startCommand: "pnpm dev",
			urls: ["http://localhost:5173/"],
			files,
			browser: "Chrome 155 headless, Playwright 1.63.0",
			videoSeconds: 6,
			captureStartedAt: "2026-10-18T16:45:11.000Z",
			captureFinishedAt: "2026-10-18T16:45:17.000Z",
		});
		expect(record?.manifest?.video).toEqual({
			file: "recording.webm",
			seconds: 6,
		});
		expect(
			Date.parse(record?.expiresAt ?? "") - Date.parse(record?.createdAt ?? ""),
		).toBe(30 * 24 * 60 * 60 * 1000);
		expect(await evidenceForOwner("bob", project, id(1))).toBeNull();
		expect(await evidenceForOwner("alice", otherProject, id(1))).toBeNull();
		// Another user cannot finish (overwrite) someone else's capture.
		await finishEvidence("bob", id(1), {
			manifest: { ...manifest, status: "dirty" },
			headSha: null,
			files: [],
		});
		expect((await evidenceForOwner("alice", project, id(1)))?.status).toBe(
			"captured",
		);
	});

	it("keeps the newest five per pull request", async () => {
		for (let n = 1; n <= 7; n++) {
			await capture(n);
			await db.query(
				"update pr_evidence set created_at=now() - make_interval(mins => $2) where id=$1",
				[id(n), 10 - n],
			);
		}
		await capture(8, 9);
		const old = await supersededEvidence({
			userId: "alice",
			projectId: project,
			fullName: "owner/app",
			pullNumber: 7,
		});
		expect(old.map((row) => row.id).sort()).toEqual([id(1), id(2)]);
		expect(await deleteEvidenceRows(old.map((row) => row.id))).toBe(2);
	});

	it("finds expired captures, closed pull requests and stale captures", async () => {
		await capture(1, 7);
		await capture(2, 8);
		await db.query(
			"update pr_evidence set expires_at=now() - interval '1 minute', created_at=now() - interval '2 hours' where id=$1",
			[id(1)],
		);
		expect((await expiredEvidence(new Date())).map((row) => row.id)).toEqual([
			id(1),
		]);
		expect(await evidenceRepositories()).toEqual([
			{ installationId: 2, fullName: "owner/app" },
		]);
		expect(
			(
				await evidenceOfClosedPulls(
					{ installationId: 2, fullName: "owner/app" },
					new Set([7]),
				)
			).map((row) => row.id),
		).toEqual([id(2)]);
		expect(await failStaleCaptures(new Date())).toBe(1);
		expect((await evidenceForOwner("alice", project, id(1)))?.status).toBe(
			"tooling-failed",
		);
		expect((await evidenceForOwner("alice", project, id(2)))?.status).toBe(
			"capturing",
		);
	});

	it("goes with its project and account; a deleted chat only unlinks it", async () => {
		await capture(1);
		await db.query("delete from agent_session where id=$1", [session]);
		expect((await evidenceForOwner("alice", project, id(1)))?.sessionId).toBe(
			null,
		);
		expect(await evidenceOfOwner("alice", project)).toHaveLength(1);
		await db.query("delete from project where id=$1", [project]);
		expect(await evidenceOfOwner("alice")).toEqual([]);
		await db.query(
			"insert into project(id,user_id,repository_id,installation_id,full_name,branch) values($1,'alice',1,2,'owner/app','main')",
			[project],
		);
		await insertCapturingEvidence({
			id: id(2),
			userId: "alice",
			projectId: project,
			sessionId: null,
			installationId: 2,
			fullName: "owner/app",
			pullNumber: 7,
			commitSha: sha,
			planKey: "auto-abc",
			kind: "cli",
		});
		await db.query("delete from auth_user where id='alice'");
		expect(
			(await db.query("select count(*)::int as n from pr_evidence")).rows,
		).toEqual([{ n: 0 }]);
	});

	it("is closed to Data API roles", async () => {
		for (const role of ["anon", "authenticated"]) {
			const grants = await db.query<{ allowed: boolean }>(
				"select has_table_privilege($1,'pr_evidence','SELECT') as allowed",
				[role],
			);
			expect(grants.rows[0].allowed).toBe(false);
		}
	});
});
