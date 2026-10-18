import { createHash, randomBytes } from "node:crypto";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	EVIDENCE_LIMITS,
	type EvidenceManifest,
	type EvidencePlan,
	evidenceContentType,
	evidenceFileLimit,
	evidenceFileUrl,
	evidenceManifest,
	evidencePlanFor,
	evidencePlanKey,
	evidenceRequestFromText,
	evidenceSectionState,
	evidenceUserLabel,
	renderEvidenceSection,
	withEvidenceSection,
} from "#/domain/pr-evidence";
import { publicToolDetail } from "#/domain/tool-detail";
import { harnessVariantForUser } from "#/server/adapters/dev-eval-users";
import { appPullRequestBody } from "../adapters/github/pr-evidence-body";
import {
	appEvidenceGitApi,
	type EvidenceGitApi,
	publishEvidenceCommit,
} from "../adapters/github/pr-evidence-refs";
import {
	evidenceCaptureCommand,
	evidenceCaptureFiles,
} from "./pr-evidence-capture";
import type { TurnGitRuntime } from "./turn-publication";

/** Where `ytimesy-evidence capture` saves the builder's plan in the workspace. */
export const EVIDENCE_REQUEST_PATH = "$HOME/.ytimesy/evidence/request.json";

/** The user's label in evidence ref names: a digest, never the id itself. */
export function evidenceUserLabelFor(userId: string) {
	return evidenceUserLabel(
		createHash("sha256").update(`ytimesy:pr-evidence:${userId}`).digest("hex"),
	);
}

export type EvidenceDependencies = {
	enabled(userId: string): Promise<boolean>;
	pullRequest: typeof appPullRequestBody;
	git(
		installationId: number | string,
		fullName: string,
	): Promise<EvidenceGitApi>;
};

const defaults: EvidenceDependencies = {
	enabled: async (userId) =>
		(await harnessVariantForUser(userId)).prEvidence === "on",
	pullRequest: appPullRequestBody,
	git: appEvidenceGitApi,
};

/** Whether this user's handoffs queue evidence at all (harness variant prEvidence). */
export function pullRequestEvidenceEnabled(
	userId: string,
	deps: Pick<EvidenceDependencies, "enabled"> = defaults,
) {
	return deps.enabled(userId);
}

export type EvidenceOutcome =
	| { kind: "off" | "not-visible" | "unchanged" | "closed" }
	| {
			kind: "updated";
			status: EvidenceManifest["status"];
			commit: string | null;
	  };

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
 * The background capture behind a turn's draft handoff (job kind
 * pr-evidence): when the change is visible (or the builder saved a capture
 * plan), check out the pushed commit in a separate worktree in the
 * workspace, capture it, store the media in the repository under a hidden
 * per-pull-request ref, and replace the pull request's Evidence section. A
 * failed start is reported in the section, never hidden behind older images.
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
	const before = await pull.read();
	if (before.state !== "open") return { kind: "closed" };
	const state = evidenceSectionState(before.body);
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
			: evidenceManifest.parse({
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
				});
		manifest.reason = publicToolDetail(manifest.reason, "output").slice(0, 600);
		// The manifest is only trusted for what the harness can check.
		if (manifest.mode !== "verify" || manifest.sha !== commit) {
			manifest.status = "dirty";
			manifest.reason = "The capture did not come from the pushed commit.";
		}
		// The pull request may have moved on while the capture ran.
		const current = await pull.read();
		if (current.state !== "open") return { kind: "closed" };
		if (manifest.status === "captured" && current.headSha !== commit) {
			manifest.status = "dirty";
			manifest.reason = `The pull request head is now ${current.headSha.slice(0, 7)}, not the captured commit; a later handoff captures it.`;
		}
		const links: Record<string, string> = {};
		let manifestUrl: string | null = null;
		let cliOutput: string | undefined;
		let stored: string | null = null;
		if (manifest.status === "captured") {
			const files: { name: string; data: Uint8Array }[] = [];
			for (const file of manifest.files) {
				if (!evidenceContentType(file.name)) continue;
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
				files.push({ name: file.name, data });
			}
			files.push({
				name: "manifest.json",
				data: Buffer.from(
					JSON.stringify(
						{
							...manifest,
							pullRequest: `${input.fullName}#${input.pullNumber}`,
							headSha: current.headSha,
							storedAt: new Date().toISOString(),
							capturedBy: "ytimesy harness (prEvidence)",
							note: "SHA-256 values are of the files as captured; output.txt is stored after secret redaction.",
						},
						null,
						2,
					),
				),
			});
			const git = await deps.git(input.installationId, input.fullName);
			stored = await publishEvidenceCommit(git, {
				userLabel: evidenceUserLabelFor(input.userId),
				pullNumber: input.pullNumber,
				files,
				message: `ytimesy evidence for #${input.pullNumber} at ${commit.slice(0, 7)}`,
			});
			for (const file of files)
				links[file.name] = evidenceFileUrl(input.fullName, stored, file.name);
			manifestUrl = links["manifest.json"] ?? null;
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
		return { kind: "updated", status: manifest.status, commit: stored };
	} finally {
		await sh(
			runtime,
			providerRef,
			`rm -rf ${quote(work)}; git -C ${quote(directory)} worktree prune`,
			15_000,
		).catch(() => undefined);
	}
}
