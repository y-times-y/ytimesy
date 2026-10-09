import { createHmac } from "node:crypto";
import { issueGitProxyGrant } from "../src/domain/github-git-proxy";
import { closeDatabase, database } from "../src/server/adapters/database";

const endpoint =
	"https://ytimesy-edge-executor-development.hetkp8044.workers.dev";
const root = process.env.BETTER_AUTH_SECRET;
if (!root || root.length < 32) throw new Error("Signing secret is missing.");
const secret =
	process.env.YTIMESY_GIT_PROXY_SECRET ||
	createHmac("sha256", root)
		.update("ytimesy:git-proxy:development:v1")
		.digest("hex");
try {
	const project = (
		await database().query<{
			userId: string;
			projectId: string;
			fullName: string;
			installationId: number;
		}>(
			`select p.user_id as "userId",p.id as "projectId",r.full_name as "fullName",r.installation_id::float8 as "installationId"
		 from project p join project_repository r on r.project_id=p.id
		 join github_connection g on g.user_id=p.user_id
		 order by p.created_at desc,r.position limit 1`,
		)
	).rows[0];
	if (!project)
		throw new Error("No connected development repository is available.");
	const [owner, name] = project.fullName.split("/");
	const url = `${endpoint}/git/${owner}/${name}.git/info/refs?service=git-upload-pack`;
	const unsigned = await fetch(url);
	if (unsigned.status !== 401)
		throw new Error(`Unsigned Git rejection failed (${unsigned.status}).`);
	const response = await fetch(url, {
		headers: await issueGitProxyGrant(secret, {
			userId: project.userId,
			projectId: project.projectId,
			installationId: project.installationId,
			owner,
			name,
			access: "read",
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok)
		throw new Error(`Live Git advertisement failed (${response.status}).`);
	if (
		response.headers.get("content-type") !==
		"application/x-git-upload-pack-advertisement"
	)
		throw new Error("Invalid Git advertisement media type.");
	// Drain without logging refs, repository names, code, or credentials.
	let bytes = 0;
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Git advertisement stream is missing.");
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		bytes += part.value.byteLength;
	}
	if (!bytes) throw new Error("Git advertisement was empty.");
	console.log(
		`Live development Git read verified: unsigned=401, signed=200, streamed=${bytes} bytes. No VM or inference used.`,
	);
} finally {
	await closeDatabase();
}
