import { createHash, randomBytes, randomUUID } from "node:crypto";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	EVIDENCE_LIMITS,
	type EvidenceManifest,
	type EvidencePlan,
	evidenceContentType,
	evidenceFileLimit,
	evidenceManifest,
	evidencePageUrl,
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
	deleteEvidenceRows,
	finishEvidence,
	insertCapturingEvidence,
	supersededEvidence,
} from "../adapters/pr-evidence-records";
import {
	type EvidenceStore,
	evidenceCapturePrefix,
	evidenceObjectKey,
	evidenceStoreConfigured,
	r2EvidenceStore,
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
	pullRequest: typeof appPullRequestBody;
	/** Private media storage, or null when none is configured. */
	store(): EvidenceStore | null;
	records: {
		insert: typeof insertCapturingEvidence;
		finish: typeof finishEvidence;
		superseded: typeof supersededEvidence;
		remove: typeof deleteEvidenceRows;
	};
	appUrl(): string | undefined;
	newId(): string;
};

const defaults: EvidenceDependencies = {
	enabled: async (userId) =>
		(await harnessVariantForUser(userId)).prEvidence === "on",
	pullRequest: appPullRequestBody,
	store: () => (evidenceStoreConfigured() ? r2EvidenceStore : null),
	records: {
		insert: insertCapturingEvidence,
		finish: finishEvidence,
		superseded: supersededEvidence,
		remove: deleteEvidenceRows,
	},
	appUrl: () => process.env.APP_URL,
	newId: randomUUID,
};

/** Whether this user's handoffs queue evidence at all (harness variant prEvidence). */
export function pullRequestEvidenceEnabled(
	userId: string,
	deps: Pick<EvidenceDependencies, "enabled"> = defaults,
) {
	return deps.enabled(userId);
}

export type EvidenceOutcome =
	| { kind: "off" | "not-visible" | "unchanged" | "closed" | "no-storage" }
	| {
			kind: "updated";
			status: EvidenceManifest["status"];
			evidenceId: string;
	  };

async function sh(
	runtime: TurnGitRuntime,
	providerRef: string,
	command: string,
	timeout: number,
) {
	return runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout);
}

/** Runs one shell command in the workspace. */
export type WorkspaceShell = (
	command: string,
	timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;

/** Copies a workspace file out in 1 MiB pieces and checks its size and SHA-256 against the manifest. */
export async function readEvidenceBytes(
	runtime: TurnGitRuntime,
	providerRef: string,
	path: string,
	expected: { bytes: number; sha256: string; name: string },
) {
	return readWorkspaceBytes(
		(command, timeout) => sh(runtime, providerRef, command, timeout),
		path,
		expected,
	);
}

/** readEvidenceBytes over any workspace shell. */
export async function readWorkspaceBytes(
	shell: WorkspaceShell,
	path: string,
	expected: { bytes: number; sha256: string; name: string },
) {
	if (expected.bytes > evidenceFileLimit(expected.name))
		throw new Error(`${expected.name} is over its size limit.`);
	const chunk = 1024 * 1024;
	const parts: Buffer[] = [];
	for (let index = 0; index * chunk < expected.bytes; index++) {
		const piece = await shell(
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
 * workspace, capture it, store the media privately in ytimesy and replace
 * the pull request's Evidence section with a summary and a link to the
 * evidence page. Nothing is written into the repository. A failed start is
 * reported, never hidden behind older media.
 */
export async function attachPullRequestEvidence(
	input: {
		userId: string;
		projectId: string;
		sessionId: string | null;
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
	const store = deps.store();
	if (!store) return { kind: "no-storage" };
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
	if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit))
		throw new Error("The pushed commit could not be resolved.");
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

	const evidenceId = deps.newId();
	const scope = { userId: input.userId, projectId: input.projectId };
	await deps.records.insert({
		id: evidenceId,
		userId: input.userId,
		projectId: input.projectId,
		sessionId: input.sessionId,
		installationId: input.installationId,
		fullName: input.fullName,
		pullNumber: input.pullNumber,
		commitSha: commit,
		planKey,
		kind: plan.mode === "cli" ? "cli" : "web",
	});
	const work = `/tmp/ytimesy-evidence-${randomBytes(8).toString("hex")}`;
	let finished = false;
	const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const failure = (reason: string, startedAt = now()) =>
		evidenceManifest.parse({
			version: 1,
			mode: "verify",
			kind: plan.mode === "cli" ? "cli" : "web",
			status: "tooling-failed",
			reason,
			sha: commit,
			clean: false,
			startSource:
				plan.mode === "cli" ? "cli" : plan.mode === "auto" ? "auto" : "plan",
			startedAt,
			finishedAt: now(),
		});
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
		const manifest: EvidenceManifest = parsed?.success
			? parsed.data
			: failure(
					"The capture ended without a readable manifest (time limit or crash).",
				);
		manifest.reason = publicToolDetail(manifest.reason, "output").slice(0, 600);
		// The manifest is only trusted for what the harness can check.
		if (manifest.mode !== "verify" || manifest.sha !== commit) {
			manifest.status = "dirty";
			manifest.reason = "The capture did not come from the pushed commit.";
		}
		// The pull request may have moved on while the capture ran.
		const current = await pull.read();
		if (current.state !== "open") {
			await deps.records.remove([evidenceId]);
			finished = true;
			return { kind: "closed" };
		}
		if (manifest.status === "captured" && current.headSha !== commit) {
			manifest.status = "dirty";
			manifest.reason = `The pull request head is now ${current.headSha.slice(0, 7)}, not the captured commit; a later handoff captures it.`;
		}
		const stored: { name: string; bytes: number; sha256: string }[] = [];
		if (manifest.status === "captured") {
			for (const file of manifest.files) {
				const contentType = evidenceContentType(file.name);
				if (!contentType || file.name === "manifest.json") continue;
				let data = await readEvidenceBytes(
					runtime,
					providerRef,
					`${work}/out/${file.name}`,
					file,
				);
				if (file.name === manifest.cli?.file)
					data = Buffer.from(
						publicToolDetail(data.toString("utf8"), "output").slice(
							0,
							EVIDENCE_LIMITS.cliOutputChars + 40,
						),
						"utf8",
					);
				await store.put(
					evidenceObjectKey(scope, evidenceId, file.name),
					data,
					contentType,
				);
				stored.push({
					name: file.name,
					bytes: data.length,
					sha256: createHash("sha256").update(data).digest("hex"),
				});
			}
		}
		await deps.records.finish(input.userId, evidenceId, {
			manifest,
			headSha: current.headSha,
			files: stored,
		});
		finished = true;
		const section = renderEvidenceSection({
			manifest,
			planKey,
			headSha: current.headSha,
			pageUrl: evidencePageUrl(deps.appUrl(), input.projectId, evidenceId),
		});
		await pull.write(withEvidenceSection(current.body, section));
		await removeSupersededEvidence(input, store, deps).catch(() => undefined);
		return { kind: "updated", status: manifest.status, evidenceId };
	} catch (error) {
		if (!finished) {
			// Nothing half-stored stays behind a row that says it failed.
			await store
				.removePrefix(evidenceCapturePrefix(scope, evidenceId))
				.catch(() => undefined);
			await deps.records
				.finish(input.userId, evidenceId, {
					manifest: failure("Storing the capture failed."),
					headSha: null,
					files: [],
				})
				.catch(() => undefined);
		}
		throw error;
	} finally {
		await sh(
			runtime,
			providerRef,
			`rm -rf ${quote(work)}; git -C ${quote(directory)} worktree prune`,
			15_000,
		).catch(() => undefined);
	}
}

/** Keeps the newest few captures of this pull request; older media and rows go. */
async function removeSupersededEvidence(
	input: {
		userId: string;
		projectId: string;
		fullName: string;
		pullNumber: number;
	},
	store: EvidenceStore,
	deps: EvidenceDependencies,
) {
	const old = await deps.records.superseded(input);
	for (const row of old)
		await store.removePrefix(evidenceCapturePrefix(row, row.id));
	await deps.records.remove(old.map((row) => row.id));
}
