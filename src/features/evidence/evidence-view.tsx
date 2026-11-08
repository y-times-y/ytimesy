import { useQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	ArrowUpRight,
	Camera,
	ExternalLink,
	Video,
} from "lucide-react";
import {
	agentCapturesSummary,
	EVIDENCE_RETENTION_DAYS,
	type EvidenceContext,
	type EvidenceRecord,
	type EvidenceStatus,
	evidenceAge,
	evidenceMediaPath,
	evidenceMediaSummary,
	evidencePagePath,
	evidenceVerifiedAtHead,
	evidenceVideoFile,
} from "#/domain/pr-evidence";
import { useHydrated } from "#/features/app/first-paint";

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

/**
 * The server knows neither the reader's time zone nor locale: the server and
 * hydration render UTC in en-US, then the reader's own format takes over.
 */
function when(value: string | null, hydrated: boolean) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return hydrated
		? date.toLocaleString()
		: date.toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" });
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
	const hydrated = useHydrated();
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
						{when(evidence.captureStartedAt, hydrated)}
						{full && evidence.captureFinishedAt
							? ` to ${when(evidence.captureFinishedAt, hydrated)} (workspace clock)`
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

/** The agent's own screenshot or recording, shown where it was made; opens full size. */
function AgentCapture({ evidence }: { evidence: EvidenceRecord }) {
	const file = evidence.files[0];
	if (!file) return null;
	const src = media(evidence, file.name);
	const video = evidenceVideoFile(file.name);
	return (
		<figure
			className="agent-capture"
			aria-label={video ? "Screen recording" : "Screenshot"}
		>
			{video ? (
				<video controls preload="metadata" src={src}>
					<track kind="captions" />
				</video>
			) : (
				<a href={src} target="_blank" rel="noreferrer" title="Open full size">
					<img src={src} alt={file.name} loading="lazy" />
				</a>
			)}
			<figcaption>
				{video ? (
					<Video size={14} aria-hidden="true" />
				) : (
					<Camera size={14} aria-hidden="true" />
				)}
				<span>
					{video
						? `Recording${evidence.videoSeconds ? `, ${Math.max(1, Math.round(evidence.videoSeconds))} s` : ""}`
						: "Screenshot"}
				</span>
				<a
					className="evidence-open"
					href={src}
					target="_blank"
					rel="noreferrer"
				>
					Open <ExternalLink size={14} aria-hidden="true" />
				</a>
			</figcaption>
		</figure>
	);
}

/** The chat timeline's card for one capture: thumbnails, the recording and the facts. */
export function EvidenceCard({ evidence }: { evidence: EvidenceRecord }) {
	if (evidence.source === "agent") return <AgentCapture evidence={evidence} />;
	const shots = screenshots(evidence);
	const video = videoFile(evidence);
	// A successful capture with nothing to look at (CLI output only) adds no card
	// to the chat; its facts stay on the evidence page the pull request links.
	if (evidence.status === "captured" && !shots.length && !video) return null;
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

/**
 * The evidence page's header: which pull request and chat the capture
 * belongs to, and links back to both. Fields the record lacks are left out.
 * `now` is the server's clock, so the first paint matches hydration.
 */
export function EvidenceSummary({
	context,
	now,
}: {
	context: EvidenceContext;
	now?: string;
}) {
	const hydrated = useHydrated();
	const pr = context.pullRequest;
	const nowMs = hydrated || !now ? Date.now() : Date.parse(now);
	const age = evidenceAge(context.capturedAt, nowMs);
	const title =
		context.chatTitle ?? (pr ? `Pull request #${pr.number}` : "Evidence");
	return (
		<header className="evidence-summary">
			<p className="evidence-summary-kicker">
				{pr ? "Pull request evidence" : "No pull request yet"}
			</p>
			<h1>
				{pr && context.chatTitle ? (
					<span className="evidence-summary-number">#{pr.number} · </span>
				) : null}
				{title}
			</h1>
			<ul className="evidence-summary-facts">
				{pr ? <li>{pr.fullName}</li> : null}
				{context.branch ? (
					<li>
						<code className="evidence-summary-code">{context.branch}</code>
					</li>
				) : null}
				{context.commit ? (
					<li>
						<code className="evidence-summary-code">{context.commit}</code>
					</li>
				) : null}
				{age ? (
					<li>
						Captured{" "}
						<time
							dateTime={context.capturedAt}
							title={when(context.capturedAt, hydrated)}
						>
							{age}
						</time>
					</li>
				) : null}
			</ul>
			{pr || context.chatPath ? (
				<nav
					className="evidence-summary-links"
					aria-label="Pull request and chat"
				>
					{pr ? (
						<a
							className="evidence-summary-primary"
							href={pr.url}
							target="_blank"
							rel="noreferrer"
						>
							Open the pull request on GitHub
							<ArrowUpRight size={15} aria-hidden="true" />
						</a>
					) : null}
					{context.chatPath ? (
						<a className="evidence-summary-secondary" href={context.chatPath}>
							<ArrowLeft size={15} aria-hidden="true" />
							Back to the chat
						</a>
					) : null}
				</nav>
			) : null}
		</header>
	);
}

/** The evidence page: every stored file of one capture with how it was produced. */
export function EvidenceDetail({
	evidence,
	captures,
}: {
	evidence: EvidenceRecord;
	/** For an agent capture: its chat's agent captures, newest first. */
	captures?: readonly EvidenceRecord[];
}) {
	if (evidence.source === "agent") {
		const shown = [...(captures?.length ? captures : [evidence])].reverse();
		return (
			<article className="evidence-card evidence-page">
				<header className="evidence-header">
					<Camera size={14} aria-hidden="true" />
					<strong>Screenshots and recordings</strong>
					<span className="evidence-status" data-status="captured">
						{agentCapturesSummary(shown)}
					</span>
				</header>
				<div className="evidence-body">
					<p className="evidence-note">
						Captured by the agent on its desktop. Kept for{" "}
						{EVIDENCE_RETENTION_DAYS} days.
					</p>
					{shown.map((capture) => (
						<AgentCapture key={capture.id} evidence={capture} />
					))}
				</div>
			</article>
		);
	}
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
