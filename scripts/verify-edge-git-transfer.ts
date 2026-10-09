import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { closeDatabase, database } from "../src/server/adapters/database";
import { authorizedRepository } from "../src/server/adapters/github";
import { receiveProxiedRepository } from "../src/server/adapters/github/git-proxy-transfer";
import { githubAccessToken } from "../src/server/auth/github-connection";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "ytimesy-git-transfer-proof-"));
process.env.YTIMESY_GIT_PROXY_URL =
	"https://ytimesy-edge-executor-development.example-account.workers.dev";
try {
	const project = (
		await database().query<{
			userId: string;
			projectId: string;
			fullName: string;
			installationId: number;
			repositoryId: number;
			branch: string;
		}>(
			`select p.user_id as "userId",p.id as "projectId",r.full_name as "fullName",r.installation_id::float8 as "installationId",r.repository_id::float8 as "repositoryId",r.branch
		 from project p join project_repository r on r.project_id=p.id join github_connection g on g.user_id=p.user_id
		 order by p.created_at desc,r.position limit 1`,
		)
	).rows[0];
	if (!project)
		throw new Error("No connected development repository is available.");
	const [owner, name] = project.fullName.split("/");
	// This read-only proof selects the current default, not a possibly deleted saved task branch.
	const repository = await authorizedRepository(
		await githubAccessToken(project.userId),
		project.installationId,
		project.repositoryId,
	);
	const result = await receiveProxiedRepository(
		{
			async exec(command, timeout) {
				try {
					const output = await execute("bash", ["-lc", command], {
						timeout,
						maxBuffer: 1024 * 1024,
						env: { PATH: process.env.PATH, HOME: directory },
					});
					return { exitCode: 0, ...output };
				} catch (cause) {
					const stderr =
						cause instanceof Error && "stderr" in cause
							? String(cause.stderr)
							: "";
					const categories = [
						"couldn't find remote ref",
						"bad config",
						"invalid branch",
						"403",
						"401",
						"503",
						"SSL",
						"HTTP/2",
						"protocol error",
						"not a git repository",
					];
					console.warn(
						"Guest Git diagnostic category:",
						categories.find((value) => stderr.includes(value)) ??
							"unclassified",
					);
					return {
						exitCode: 1,
						stdout: "",
						stderr: "Private transfer failed.",
					};
				}
			},
			writeTextFile: (path, contents) =>
				writeFile(path, contents, { mode: 0o600 }),
		},
		{
			userId: project.userId,
			projectId: project.projectId,
			installationId: project.installationId,
			owner,
			name,
			branch: repository.defaultBranch,
			destination: join(directory, "checkout"),
			mode: "clone",
		},
	);
	if (result !== "updated")
		throw new Error("Read-only transfer did not complete.");
	const head = await execute("git", [
		"-C",
		join(directory, "checkout"),
		"rev-parse",
		"HEAD",
	]);
	if (!/^[a-f0-9]{40}\s*$/.test(head.stdout))
		throw new Error("Transferred repository HEAD is invalid.");
	console.log(
		"Live proxy fetch and checkout verified with the guest transfer adapter. No repository published, VM created, or inference used.",
	);
} finally {
	await closeDatabase();
	await rm(directory, { recursive: true, force: true });
}
