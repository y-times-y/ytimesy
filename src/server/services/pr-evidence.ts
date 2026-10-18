import { createHash, randomBytes } from "node:crypto";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	EVIDENCE_LIMITS,
	type EvidenceManifest,
	type EvidencePlan,
	evidenceContentType,
	evidenceFileLimit,
	evidenceManifest,
	evidencePlanFor,
	evidencePlanKey,
	evidenceRequestFromText,
	evidenceSectionState,
	renderEvidenceSection,
	withEvidenceSection,
} from "#/domain/pr-evidence";
import { publicToolDetail } from "#/domain/tool-detail";
import { harnessVariantForUser } from "#/server/adapters/dev-eval-users";
import { appPullRequestBody } from "../adapters/github/pr-evidence-body";
import {
	evidenceFileUrl,
	evidencePublicOrigin,
	evidenceStoreConfigured,
	putEvidenceFile,
} from "../adapters/pr-evidence-store";
import {
	evidenceCaptureCommand,
	evidenceCaptureFiles,
} from "./pr-evidence-capture";
import type { TurnGitRuntime } from "./turn-publication";

/** Where `ytimesy-evidence capture` saves the builder's plan in the workspace. */
export const EVIDENCE_REQUEST_PATH = "$HOME/.ytimesy/evidence/request.json";

export type EvidenceDependencies = {
	enabled(userId: string): Promise<boolean>;
	origin(): string | null;
	storeConfigured(): boolean;
	pullRequest: typeof appPullRequestBody;
	put: typeof putEvidenceFile;
	id(): string;
};

const defaults: EvidenceDependencies = {
	enabled: async (userId) =>
		(await harnessVariantForUser(userId)).prEvidence === "on",
	origin: () => evidencePublicOrigin(),
	storeConfigured: evidenceStoreConfigured,
	pullRequest: appPullRequestBody,
	put: putEvidenceFile,
	id: () => randomBytes(16).toString("hex"),
};

export type EvidenceOutcome =
	| { kind: "off" | "unconfigured" | "not-visible" | "unchanged" | "closed" }
	| { kind: "updated"; status: EvidenceManifest["status"]; id: string | null };

async function sh(
	runtime: TurnGitRuntime,
	providerRef: string,
	command: string,
	timeout: number,
) {
	return runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout);
}

/** Copies a workspace file out in 1 MiB pieces and checks its size and SHA-256 against the manifest. */
export async function readEvidenceBytes(
	runtime: TurnGitRuntime,
	providerRef: string,
	path: string,
	expected: { bytes: number; sha256: string; name: string },
) {
	if (expected.bytes > evidenceFileLimit(expected.name))
		throw new Error(`${expected.name} is over its size limit.`);
	const chunk = 1024 * 1024;
	const parts: Buffer[] = [];
	for (let index = 0; index * chunk < expected.bytes; index++) {
		const piece = await sh(
			runtime,
			providerRef,
			`dd if=${quote(path)} bs=${chunk} skip=${index} count=1 status=none | base64 -w0`,
			30_000,
		);
		if (piece.exitCode) throw new Error(`Could not read ${expected.name}.`);
		parts.push(Buffer.from(piece.stdout.trim(), "base64"));
	}
	const data = Buffer.concat(parts);
	if (
		data.length !== expected.bytes ||
		createHash("sha256").update(data).digest("hex") !== expected.sha256
	)
		throw new Error(`${expected.name} changed after capture.`);
	return data;
}

/**
 * After a turn's draft handoff: when prEvidence is on and the change is
 * visible (or the builder saved a capture plan), capture from the pushed
 * commit in the workspace, store the media, and replace the pull request's
 * Evidence section. A failed start is reported in the section, never hidden
 * behind older images.
 */
export async function attachPullRequestEvidence(
	input: {
		userId: string;
		runtime: TurnGitRuntime;
		providerRef: string;
		directory: string;
		revision: string;
		installationId: number | string;
		fullName: string;
		pullNumber: number;
	},
	deps: EvidenceDependencies = defaults,
): Promise<EvidenceOutcome> {
	if (!(await deps.enabled(input.userId))) return { kind: "off" };
	const origin = deps.origin();
	if (!origin || !deps.storeConfigured()) return { kind: "unconfigured" };
	const { runtime, providerRef, directory, revision } = input;
	const changed = await sh(
		runtime,
		providerRef,
		`git -C ${quote(directory)} diff --name-only refs/ytimesy/base ${quote(revision)} | head -n 2000`,
		30_000,
	);
	const saved = await sh(
		runtime,
		providerRef,
		`cat ${EVIDENCE_REQUEST_PATH} 2>/dev/null || true`,
		15_000,
	);
	const request = evidenceRequestFromText(saved.stdout);
	const plan: EvidencePlan | null = evidencePlanFor({
		request,
		changedPaths: changed.exitCode ? [] : changed.stdout.split("\n"),
	});
	if (!plan) return { kind: "not-visible" };
	const sha = await sh(
		runtime,
		providerRef,
		`git -C ${quote(directory)} rev-parse --verify ${quote(`${revision}^{commit}`)}`,
		15_000,
	);
	const commit = sha.stdout.trim();
	const planKey = evidencePlanKey(
		plan,
		createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
	);
	const pull = await deps.pullRequest(
		input.installationId,
		input.fullName,
		input.pullNumber,
	);
	const current = await pull.read();
	if (current.state !== "open") return { kind: "closed" };
	const state = evidenceSectionState(current.body);
	if (state && state.sha === commit && state.plan === planKey)
		return { kind: "unchanged" };

	const work = `/tmp/ytimesy-evidence-${randomBytes(8).toString("hex")}`;
	try {
		const made = await sh(
			runtime,
			providerRef,
			`install -d -m 700 ${quote(work)} ${quote(`${work}/out`)}`,
			15_000,
		);
		if (made.exitCode)
			throw new Error("Could not prepare the capture directory.");
		if (!runtime.writeTextFile)
			throw new Error("Workspace file transfer unavailable.");
		for (const [name, contents] of Object.entries(evidenceCaptureFiles()))
			await runtime.writeTextFile(providerRef, `${work}/${name}`, contents);
		await runtime.writeTextFile(
			providerRef,
			`${work}/request.json`,
			JSON.stringify(plan),
		);
		await sh(
			runtime,
			providerRef,
			evidenceCaptureCommand({
				directory: work,
				repository: directory,
				revision,
			}),
			(EVIDENCE_LIMITS.captureSeconds + 30) * 1000,
		);
		const raw = await sh(
			runtime,
			providerRef,
			`cat ${quote(`${work}/out/manifest.json`)}`,
			15_000,
		);
		const parsed = (() => {
			try {
				return evidenceManifest.safeParse(JSON.parse(raw.stdout));
			} catch {
				return null;
			}
		})();
		const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
		const manifest: EvidenceManifest = parsed?.success
			? parsed.data
			: {
					...evidenceManifest.parse({
						version: 1,
						mode: "verify",
						kind: plan.mode === "cli" ? "cli" : "web",
						status: "tooling-failed",
						reason:
							"The capture ended without a readable manifest (time limit or crash).",
						sha: commit,
						clean: false,
						startSource:
							plan.mode === "cli"
								? "cli"
								: plan.mode === "auto"
									? "auto"
									: "plan",
						startedAt: now,
						finishedAt: now,
					}),
				};
		manifest.reason = publicToolDetail(manifest.reason, "output").slice(0, 600);
		// The manifest is only trusted for what the harness can check.
		if (manifest.mode !== "verify" || manifest.sha !== commit) {
			manifest.status = "dirty";
			manifest.reason = "The capture did not come from the pushed commit.";
		}
		if (manifest.status === "captured" && current.headSha !== commit) {
			manifest.status = "dirty";
			manifest.reason = `The pull request head is ${current.headSha.slice(0, 7)}, not the captured commit.`;
		}
		let id: string | null = null;
		const links: Record<string, string> = {};
		let manifestUrl: string | null = null;
		let cliOutput: string | undefined;
		if (manifest.status === "captured") {
			id = deps.id();
			for (const file of manifest.files) {
				const contentType = evidenceContentType(file.name);
				if (!contentType) continue;
				let data = await readEvidenceBytes(
					runtime,
					providerRef,
					`${work}/out/${file.name}`,
					file,
				);
				if (file.name === manifest.cli?.file) {
					cliOutput = publicToolDetail(data.toString("utf8"), "output").slice(
						0,
						EVIDENCE_LIMITS.cliOutputChars + 40,
					);
					data = Buffer.from(cliOutput, "utf8");
				}
				await deps.put(id, file.name, data, contentType);
				links[file.name] = evidenceFileUrl(origin, id, file.name);
			}
			const record = {
				...manifest,
				pullRequest: `${input.fullName}#${input.pullNumber}`,
				headSha: current.headSha,
				storedAt: new Date().toISOString(),
				capturedBy: "ytimesy harness (prEvidence)",
			};
			await deps.put(
				id,
				"manifest.json",
				Buffer.from(JSON.stringify(record, null, 2)),
				"text/plain; charset=utf-8",
			);
			manifestUrl = evidenceFileUrl(origin, id, "manifest.json");
		}
		const section = renderEvidenceSection({
			manifest,
			links,
			manifestUrl,
			planKey,
			headSha: current.headSha,
			cliOutput,
		});
		await pull.write(withEvidenceSection(current.body, section));
		return { kind: "updated", status: manifest.status, id };
	} finally {
		await sh(runtime, providerRef, `rm -rf ${quote(work)}`, 15_000).catch(
			() => undefined,
		);
	}
}
