import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { closeDatabase, database } from "../src/server/adapters/database";
import {
	pushProxiedRepository,
	receiveProxiedRepository,
} from "../src/server/adapters/github/git-proxy-transfer";
import { githubInstallationAccessToken } from "../src/server/adapters/github/installation-token";
import { saveProjectGroup } from "../src/server/adapters/projects";
import { insertQueuedWorkspace } from "../src/server/adapters/workspaces";

// One named development repository, one temporary branch/project, no production/default-branch writes.
if (process.env.EDGE_ENVIRONMENT_PROOF !== "1")
	throw new Error("Enable EDGE_ENVIRONMENT_PROOF=1.");
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
		"zqkptvyvoyqqtpihlshw" ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(
		"zqkptvyvoyqqtpihlshw",
	)
)
	throw new Error("Not development.");
const origin =
	"https://ytimesy-edge-executor-development.hetkp8044.workers.dev";
const root = process.env.BETTER_AUTH_SECRET;
const key = process.env.FREESTYLE_API_KEY;
if (!root || root.length < 32 || !key)
	throw new Error("Proof configuration missing.");
process.env.YTIMESY_GIT_PROXY_URL = origin;
const secret =
	process.env.YTIMESY_ENVIRONMENT_WORKFLOW_SECRET ||
	createHmac("sha256", root)
		.update("ytimesy:environment-workflows:development:v1")
		.digest("hex");
const id = randomUUID();
const branch = `codex/edge-environment-proof-${id}`;
const directory = await mkdtemp(join(tmpdir(), "ytimesy-environment-proof-"));
const execute = promisify(execFile);
const client = new Freestyle({ apiKey: key });
let projectId: string | undefined;
let workspaceId: string | undefined;
let published = false;
let admitted = false;
let repository:
	| {
			userId: string;
			projectId: string;
			installationId: number;
			repositoryId: number;
			owner: string;
			name: string;
	  }
	| undefined;
const host = {
	async exec(command: string, timeout: number) {
		try {
			return {
				exitCode: 0,
				...(await execute("bash", ["-lc", command], {
					timeout,
					env: { PATH: process.env.PATH, HOME: directory },
					maxBuffer: 1024 * 1024,
				})),
			};
		} catch {
			return {
				exitCode: 1,
				stdout: "",
				stderr: "Private Git transfer failed.",
			};
		}
	},
	writeTextFile: async (path: string, contents: string) => {
		await writeFile(path, contents, { mode: 0o600 });
	},
};
try {
	const source = (
		await database().query<{
			userId: string;
			projectId: string;
			installationId: number;
			repositoryId: number;
		}>(
			`select user_id as "userId",id as "projectId",installation_id::float8 as "installationId",repository_id::float8 as "repositoryId" from project where full_name='y-times-y/ytimesy' order by created_at desc limit 1`,
		)
	).rows[0];
	if (!source) throw new Error("Named development repository is unavailable.");
	repository = { ...source, owner: "y-times-y", name: "ytimesy" };
	const checkout = join(directory, "fixture");
	await mkdir(join(checkout, ".ytimesy"), { recursive: true });
	await writeFile(
		join(checkout, "package.json"),
		'{"name":"edge-proof","version":"1.0.0","private":true}',
	);
	await writeFile(
		join(checkout, ".ytimesy/environment.json"),
		JSON.stringify({
			version: 1,
			install: "printf prepared > setup-proof.txt",
			verify: ['test "$(cat setup-proof.txt)" = prepared'],
			timeoutSeconds: 60,
		}),
	);
	await execute("git", ["init", "-q", checkout]);
	await execute("git", ["-C", checkout, "add", "."]);
	await execute("git", [
		"-C",
		checkout,
		"-c",
		"user.name=ytimesy proof",
		"-c",
		"user.email=proof@example.invalid",
		"commit",
		"-qm",
		"Disposable environment fixture",
	]);
	// Prove receive-pack through the real proxy on an isolated branch, without modifying main.
	published = true;
	await pushProxiedRepository(host, {
		...repository,
		branch,
		directory: checkout,
	});
	const fetched = join(directory, "readback");
	await receiveProxiedRepository(host, {
		...repository,
		branch,
		destination: fetched,
		mode: "clone",
	});
	if (
		!(
			await readFile(join(fetched, ".ytimesy/environment.json"), "utf8")
		).includes("setup-proof.txt")
	)
		throw new Error("Git push readback failed.");
	console.info("Live isolated proxy push and fetch readback passed.");
	const project = await saveProjectGroup(
		source.userId,
		`Disposable edge environment ${id}`,
		[
			{
				repositoryId: source.repositoryId,
				installationId: source.installationId,
				fullName: "y-times-y/ytimesy",
				branch,
			},
		],
	);
	projectId = project.id;
	const workspace = await insertQueuedWorkspace(source.userId, project.id);
	workspaceId = workspace.id;
	const url = `${origin}/environment/start`;
	const body = JSON.stringify({
		requestId: id,
		workspaceId,
		force: true,
		repairModel: null,
	});
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(secret, "POST", url, body),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 202) {
			admitted = true;
			break;
		}
		if (response.status !== 503)
			throw new Error(`Environment admission rejected (${response.status}).`);
		await delay(2000);
	}
	if (!admitted) throw new Error("Environment gate did not propagate.");
	const deadline = Date.now() + 240_000;
	let verified = false;
	while (Date.now() < deadline) {
		const latest = (
			await database().query<{ status: string; error_message: string | null }>(
				"select status,error_message from environment_build where workspace_id=$1 order by created_at desc limit 1",
				[workspaceId],
			)
		).rows[0];
		if (latest?.status === "failed")
			throw new Error(
				`Environment build failed (${latest.error_message ?? "no message"}); isolated build retained for cleanup.`,
			);
		if (latest?.status === "ready") {
			const build = (
				await database().query<{
					status: string;
					provider_ref: string;
					snapshot_id: string;
				}>(
					"select status,provider_ref,snapshot_id from environment_build where workspace_id=$1 order by created_at desc limit 1",
					[workspaceId],
				)
			).rows[0];
			if (
				build?.status !== "ready" ||
				!build.snapshot_id ||
				!build.provider_ref
			)
				throw new Error("Environment completion omitted activation.");
			const vm = await client.vms.ref(build.provider_ref).data();
			const snapshot = await client.vms.snapshots.get(build.snapshot_id);
			if (!["paused", "stopped"].includes(vm.state) || snapshot.public)
				throw new Error("Template cleanup/privacy verification failed.");
			const proofVm = client.vms.ref(build.provider_ref);
			try {
				const prepared = JSON.parse(
					await proofVm.fs.readTextFile("/tmp/ytimesy-environment.json"),
				) as {
					repositories: {
						branch: string;
						directory: string;
						checkResults?: { exitCode: number }[];
					}[];
				};
				const primary = prepared.repositories[0];
				const evidence = {
					oneRepository: prepared.repositories.length === 1,
					selectedBranch: primary?.branch === branch,
					checkoutDirectory: /^\/home\/[^/]+\/ytimesy$/.test(
						primary?.directory ?? "",
					),
					baselineChecksPassed: !primary?.checkResults?.some(
						(check) => check.exitCode !== 0,
					),
					installMarker: primary
						? (
								await proofVm.fs.readTextFile(
									`${primary.directory}/setup-proof.txt`,
								)
							).trim() === "prepared"
						: false,
				};
				console.info("Isolated environment fixture evidence:", evidence);
				if (!Object.values(evidence).every(Boolean))
					throw new Error(
						"Environment proof did not prepare the exact isolated fixture.",
					);
			} finally {
				const afterRead = await proofVm.data();
				if (afterRead.state === "running") await proofVm.pause();
			}
			verified = true;
			console.info(
				"Live environment build (project Durable Object): clone, install, verify, private snapshot activation, and setup-VM pause passed.",
			);
			break;
		}
		await delay(3000);
	}
	if (!verified) throw new Error("Environment proof deadline exceeded.");
} finally {
	const failures: string[] = [];
	const clean = async (name: string, run: () => unknown | Promise<unknown>) => {
		try {
			await run();
		} catch {
			failures.push(name);
		}
	};
	if (workspaceId) {
		const builds = (
			await database().query<{
				id: string;
				provider_ref: string | null;
				snapshot_id: string | null;
			}>(
				"select id,provider_ref,snapshot_id from environment_build where workspace_id=$1",
				[workspaceId],
			)
		).rows;
		for (const build of builds) {
			const snapshotId = build.snapshot_id;
			const providerRef =
				build.provider_ref ||
				(await client.vms.list({ slug: `ytimesy-build-${build.id}`, limit: 1 }))
					.vms[0]?.id;
			if (snapshotId)
				await clean("snapshot", () => client.vms.snapshots.delete(snapshotId));
			if (providerRef) await clean("VM", () => client.vms.delete(providerRef));
		}
	}
	if (projectId)
		await clean("project", () =>
			database().query("delete from project where id=$1", [projectId]),
		);
	if (published && repository) {
		const repo = repository;
		await clean("temporary branch", async () => {
			const token = await githubInstallationAccessToken(repo.installationId, {
				repositoryNames: [repo.name],
				contents: "write",
			});
			await new Octokit({ auth: token }).git.deleteRef({
				owner: repo.owner,
				repo: repo.name,
				ref: `heads/${branch}`,
			});
		});
	}
	await closeDatabase();
	await rm(directory, { recursive: true, force: true });
	if (failures.length) {
		console.error(
			`Environment proof cleanup incomplete: ${failures.join(", ")}.`,
		);
		process.exitCode = 1;
	} else console.info("Disposable environment proof resources removed.");
}
