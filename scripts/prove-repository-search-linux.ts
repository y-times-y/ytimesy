import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Freestyle } from "freestyle";
import { proofCreateVmFields } from "#/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";

const [flag, cap, outputDirectory] = process.argv.slice(2);
if (
	flag !== "--live" ||
	!Number.isFinite(Number(cap)) ||
	Number(cap) < 1 ||
	Number(cap) > 10 ||
	!outputDirectory
)
	throw new Error(
		"Usage: prove-repository-search-linux --live <approved-cap-usd:1..10> <new-private-output-directory>.",
	);
const proofId = randomUUID();
const slug = `ytimesy-search-proof-${proofId.slice(0, 8)}`;
await mkdir(outputDirectory, { mode: 0o700 });
const save = (name: string, value: unknown) =>
	writeFile(resolve(outputDirectory, name), JSON.stringify(value, null, 2), {
		mode: 0o600,
	});
const run = promisify(execFile);
const revision = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
const paths = [
	"scripts/benchmark-repository-search.ts",
	"src/server/services/indexed-repository-search.ts",
];
const sources = [];
for (const path of paths)
	sources.push({
		path,
		sha256: createHash("sha256")
			.update(await readFile(path))
			.digest("hex"),
	});
const bundle = await build({
	entryPoints: [paths[0]],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	logLevel: "silent",
});
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
let vmId: string | undefined;
let creationAttempted = false;
let failure: unknown;
try {
	await save("resources.json", {
		revision,
		proofId,
		slug,
		sources,
		approvedCapUsd: Number(cap),
		computeEnvelopeUsd: 0.023,
		limitation:
			"Published standard small-VM compute/storage rates, not invoice reconciliation. No inference or shared worker deployment.",
	});
	creationAttempted = true;
	const created = await client.vms.create({
		...proofCreateVmFields({
			slug,
			snapshotId: "freestyle/ubuntu-sm",
			ttlSeconds: 600,
			idleTimeoutSeconds: 120,
		}),
		metadata: { purpose: "ytimesy-disposable-search-proof", proofId },
		automaticRestart: false,
		maxRunTotalSeconds: 600,
		maxRunSeconds: 600,
		autoDeleteSeconds: 0,
	});
	vmId = created.vmId;
	await save("active-resource.json", { vmId, proofId, slug });
	const running = await waitUntilVmRunning(
		created.vm,
		"Disposable Linux search proof",
	);
	assert.equal(running.resources.cpu, 2);
	assert.equal(running.resources.memory, 4096);
	assert.ok(running.resources.storage <= 16384);
	await created.vm.fs.writeTextFile(
		"/tmp/repository-search-benchmark.mjs",
		bundle.outputFiles[0].text,
	);
	const result = await created.vm.exec({
		command: "node /tmp/repository-search-benchmark.mjs 16 32 64",
		timeoutMs: 120_000,
	});
	assert.equal(result.statusCode, 0, result.stderr?.slice(-1200));
	const samples = (result.stdout ?? "")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(samples.length, 3);
	assert.ok(
		samples.every(
			(corpus) =>
				corpus.samples.length === 6 &&
				corpus.samples.every(
					(sample: { identical: boolean }) => sample.identical,
				),
		),
	);
	await save("evidence.json", {
		status: "passed",
		capturedAt: new Date().toISOString(),
		revision,
		sources,
		resources: running.resources,
		samples,
		limitation:
			"Sequential synthetic Linux timing on one disposable VM, not a representative repository, agent benchmark, or Cursor comparison.",
	});
	console.log(JSON.stringify(samples));
} catch (error) {
	failure = error;
	await save("failed-evidence.json", {
		status: "failed",
		errorType: error instanceof Error ? error.name : "unknown",
	});
} finally {
	if (creationAttempted && !vmId)
		failure = new AggregateError(
			[
				...(failure ? [failure] : []),
				new Error(
					"VM creation outcome unknown; reconcile the unique proof slug before retrying.",
				),
			],
			"Uncertain resource creation",
		);
	if (vmId) {
		try {
			const own = await client.vms.get(vmId);
			assert.equal(own.metadata?.proofId, proofId);
			await client.vms.delete(vmId);
			const remaining = await client.vms.list({ slug });
			assert.ok(!remaining.vms.some((vm) => vm.id === vmId));
			await save("cleanup.json", { ownedVmAbsent: true });
		} catch (error) {
			failure = new AggregateError(
				[...(failure ? [failure] : []), error],
				"Proof cleanup could not be confirmed",
			);
		}
	}
}
if (failure) throw failure;
