import { useQuery } from "@tanstack/react-query";
import { Camera, ExternalLink } from "lucide-react";
import {
	EVIDENCE_RETENTION_DAYS,
	type EvidenceRecord,
	type EvidenceStatus,
	evidenceMediaPath,
	evidenceMediaSummary,
	evidencePagePath,
	evidenceVerifiedAtHead,
} from "#/domain/pr-evidence";

const STATUS_LABEL: Record<EvidenceStatus, string> = {
	capturing: "Capturing",
	captured: "Captured",
	"app-failed": "App did not start",
	dirty: "Not from the pushed commit",
	"tooling-failed": "Capture failed",
};

type Shot = { name: string; label: string };

/** Stored screenshots in capture order, labelled by page or flow step. */
function screenshots(evidence: EvidenceRecord): Shot[] {
	const stored = new Set(evidence.files.map((file) => file.name));
	const shots: Shot[] = [];
	for (const page of evidence.manifest?.pages ?? [])
		if (page.screenshot && stored.has(page.screenshot))
			shots.push({
				name: page.screenshot,
				label: page.title ? `${page.title} (${page.url})` : page.url,
			});
	for (const step of evidence.manifest?.flow ?? [])
		if (step.screenshot && stored.has(step.screenshot))
			shots.push({ name: step.screenshot, label: `After ${step.step}` });
	return shots;
}

function videoFile(evidence: EvidenceRecord) {
	const file = evidence.manifest?.video?.file;
	return file && evidence.files.some((stored) => stored.name === file)
		? file
		: null;
}

const media = (evidence: EvidenceRecord, name: string) =>
	evidenceMediaPath(evidence.projectId, evidence.id, name);

function short(sha: string | null) {
	return sha ? sha.slice(0, 7) : "unknown";
}

function when(value: string | null) {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** What the harness checked, in plain facts. */
function EvidenceFacts({
	evidence,
	full,
}: {
	evidence: EvidenceRecord;
	full?: boolean;
}) {
	const manifest = evidence.manifest;
	const atHead = manifest
		? evidenceVerifiedAtHead(manifest, evidence.headSha)
		: false;
	const failedSteps = manifest?.flow.filter((step) => !step.ok) ?? [];
	return (
		<dl className="evidence-facts">
			<dt>Commit</dt>
			<dd>
				<code>{full ? evidence.commitSha : short(evidence.commitSha)}</code>
				{atHead
					? " (clean checkout of the pull request head)"
					: evidence.headSha && evidence.headSha !== evidence.commitSha
						? ` (pull request head was ${short(evidence.headSha)})`
						: ""}
			</dd>
			{evidence.reason ? (
				<>
					<dt>Why</dt>
					<dd>{evidence.reason}</dd>
				</>
			) : null}
			{evidence.startCommand ? (
				<>
					<dt>Start command</dt>
					<dd>
						<code>{evidence.startCommand}</code>
						{manifest?.startSource === "auto"
							? " (detected from package.json)"
							: manifest?.startSource === "plan"
								? " (from the builder's capture plan)"
								: ""}
					</dd>
				</>
			) : null}
			{full && evidence.urls.length ? (
				<>
					<dt>Pages visited</dt>
					<dd>
						{evidence.urls.map((url) => (
							<code key={url}>{url}</code>
						))}
					</dd>
				</>
			) : null}
			{manifest?.flow.length ? (
				<>
					<dt>Flow</dt>
					<dd>
						{manifest.flow.length} step{manifest.flow.length === 1 ? "" : "s"}
						{failedSteps.length
							? `, ${failedSteps.length} failed`
							: ", all passed"}
					</dd>
				</>
			) : null}
			{evidence.browser ? (
				<>
					<dt>Browser</dt>
					<dd>
						{evidence.browser}
						{manifest?.viewport ? `, ${manifest.viewport}` : ""}
					</dd>
				</>
			) : null}
			{evidence.captureStartedAt ? (
				<>
					<dt>Captured</dt>
					<dd>
						{when(evidence.captureStartedAt)}
						{full && evidence.captureFinishedAt
							? ` to ${when(evidence.captureFinishedAt)} (workspace clock)`
							: ""}
					</dd>
				</>
			) : null}
			{full && manifest?.linked.length ? (
				<>
					<dt>Not from the commit</dt>
					<dd>
						{manifest.linked.join(", ")} (installed dependencies linked and env
						files copied from the chat's checkout)
					</dd>
				</>
			) : null}
			{full && manifest?.dropped.length ? (
				<>
					<dt>Left out</dt>
					<dd>{manifest.dropped.join("; ")}</dd>
				</>
			) : null}
		</dl>
	);
}

function EvidenceHeader({
	evidence,
	link,
}: {
	evidence: EvidenceRecord;
	link?: boolean;
}) {
	return (
		<header className="evidence-header">
			<Camera size={14} aria-hidden="true" />
			<strong>
				Evidence for {evidence.fullName}#{evidence.pullNumber}
			</strong>
			<span className="evidence-status" data-status={evidence.status}>
				{STATUS_LABEL[evidence.status]}
			</span>
			{link ? (
				<a
					className="evidence-open"
					href={evidencePagePath(evidence.projectId, evidence.id)}
					target="_blank"
					rel="noreferrer"
				>
					Open <ExternalLink size={14} aria-hidden="true" />
				</a>
			) : null}
		</header>
	);
}

/** The chat timeline's card for one capture: thumbnails, the recording and the facts. */
export function EvidenceCard({ evidence }: { evidence: EvidenceRecord }) {
	const shots = screenshots(evidence);
	const video = videoFile(evidence);
	const summary = evidenceMediaSummary({
		files: evidence.files,
		videoSeconds: evidence.videoSeconds,
		kind: evidence.kind,
	});
	return (
		<section
			className="evidence-card"
			data-status={evidence.status}
			aria-label="Pull request evidence"
		>
			<EvidenceHeader evidence={evidence} link />
			<div className="evidence-body">
				{evidence.status === "capturing" ? (
					<p className="evidence-note">
						Capturing commit <code>{short(evidence.commitSha)}</code> in the
						background.
					</p>
				) : summary ? (
					<p className="evidence-note">{summary}</p>
				) : null}
				{shots.length ? (
					<ul className="evidence-thumbnails">
						{shots.slice(0, 4).map((shot) => (
							<li key={shot.name}>
								<a
									href={media(evidence, shot.name)}
									target="_blank"
									rel="noreferrer"
								>
									<img
										src={media(evidence, shot.name)}
										alt={shot.label}
										loading="lazy"
									/>
								</a>
							</li>
						))}
					</ul>
				) : null}
				{video ? (
					<video
						className="evidence-video"
						controls
						preload="metadata"
						src={media(evidence, video)}
					>
						<track kind="captions" />
					</video>
				) : null}
				{evidence.status !== "capturing" ? (
					<EvidenceFacts evidence={evidence} />
				) : null}
			</div>
		</section>
	);
}

function CliOutput({
	evidence,
	file,
}: {
	evidence: EvidenceRecord;
	file: string;
}) {
	const output = useQuery({
		queryKey: ["evidence-output", evidence.id, file],
		queryFn: async () => {
			const response = await fetch(media(evidence, file), {
				credentials: "same-origin",
			});
			if (!response.ok) throw new Error("The output is unavailable.");
			return response.text();
		},
	});
	return (
		<pre className="evidence-output">
			{output.data ??
				(output.isError ? "The output is unavailable." : "Loading output")}
		</pre>
	);
}

/** The evidence page: every stored file of one capture with how it was produced. */
export function EvidenceDetail({ evidence }: { evidence: EvidenceRecord }) {
	const shots = screenshots(evidence);
	const video = videoFile(evidence);
	const cli = evidence.manifest?.cli;
	const cliStored =
		cli && evidence.files.some((file) => file.name === cli.file) ? cli : null;
	return (
		<article
			className="evidence-card evidence-page"
			data-status={evidence.status}
		>
			<EvidenceHeader evidence={evidence} />
			<div className="evidence-body">
				<p className="evidence-note">
					Captured by the ytimesy harness from the pushed commit. Kept for{" "}
					{EVIDENCE_RETENTION_DAYS} days or until the pull request closes.
				</p>
				<EvidenceFacts evidence={evidence} full />
				{cliStored ? (
					<section>
						<h2>
							<code>{cliStored.command}</code> exited{" "}
							{cliStored.exitCode ?? "without a status (timed out)"}
						</h2>
						<CliOutput evidence={evidence} file={cliStored.file} />
					</section>
				) : null}
				{video ? (
					<section>
						<h2>Screen recording</h2>
						<video
							className="evidence-video"
							controls
							preload="metadata"
							src={media(evidence, video)}
						>
							<track kind="captions" />
						</video>
					</section>
				) : null}
				{shots.length ? (
					<section>
						<h2>Screenshots</h2>
						<ul className="evidence-shots">
							{shots.map((shot) => (
								<li key={shot.name}>
									<figure>
										<a
											href={media(evidence, shot.name)}
											target="_blank"
											rel="noreferrer"
										>
											<img
												src={media(evidence, shot.name)}
												alt={shot.label}
												loading="lazy"
											/>
										</a>
										<figcaption>{shot.label}</figcaption>
									</figure>
								</li>
							))}
						</ul>
					</section>
				) : null}
				{evidence.manifest?.pages.some((page) => page.error) ? (
					<section>
						<h2>Page errors</h2>
						<ul className="evidence-list">
							{evidence.manifest.pages
								.filter((page) => page.error)
								.map((page) => (
									<li key={page.url}>
										<code>{page.url}</code>
										{page.status === null ? "" : ` (HTTP ${page.status})`}:{" "}
										{page.error}
									</li>
								))}
						</ul>
					</section>
				) : null}
				{evidence.manifest?.flow.length ? (
					<section>
						<h2>Flow</h2>
						<ol className="evidence-list">
							{evidence.manifest.flow.map((step, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: steps can repeat; their position is their identity
								<li key={index} data-ok={step.ok}>
									<code>{step.step}</code>
									{step.ok ? "" : `: ${step.error || "failed"}`}
								</li>
							))}
						</ol>
					</section>
				) : null}
				{evidence.files.length ? (
					<section>
						<h2>Files</h2>
						<table className="evidence-files">
							<thead>
								<tr>
									<th>File</th>
									<th>Size</th>
									<th>SHA-256</th>
								</tr>
							</thead>
							<tbody>
								{evidence.files.map((file) => (
									<tr key={file.name}>
										<td>
											<a
												href={media(evidence, file.name)}
												target="_blank"
												rel="noreferrer"
											>
												{file.name}
											</a>
										</td>
										<td>{(file.bytes / 1024).toFixed(0)} KB</td>
										<td>
											<code>{file.sha256}</code>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				) : null}
			</div>
		</article>
	);
}
