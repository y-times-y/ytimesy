import {
	ChevronRight,
	ListChecks,
	ShieldCheck,
	ShieldQuestion,
	ShieldX,
} from "lucide-react";
import type { AgentCall } from "#/domain/agent-call";
import type { CheckSummary } from "#/domain/check-summary";
import { helperCallLabel } from "#/domain/helper-names";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { ActivityIcon } from "./activity-icon";
import { AgentMarkdown } from "./agent-markdown";

/** A tool's JSON arguments (or object result) as labelled fields, not a JSON blob; anything else as text. */
export function ToolInputFields({ input }: { input: string }) {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		return <pre className="session-output">{input}</pre>;
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return <pre className="session-output">{input}</pre>;
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0)
		return <p className="session-activity-meta">No arguments</p>;
	return (
		<dl className="session-tool-fields">
			{entries.map(([key, entry]) => {
				const text =
					typeof entry === "string" ? entry : JSON.stringify(entry, null, 2);
				return (
					<div key={key}>
						<dt>{key.replaceAll("_", " ")}</dt>
						<dd>
							{text.includes("\n") || text.length > 120 ? (
								<pre className="session-output">{text}</pre>
							) : (
								<code>{text}</code>
							)}
						</dd>
					</div>
				);
			})}
		</dl>
	);
}

/** The builder's <requirements> block: a collapsed list, not raw tags. */
export function RequirementsList({ items }: { items: readonly string[] }) {
	return (
		<details className="session-requirements">
			<summary>
				<ListChecks size={14} strokeWidth={1.5} aria-hidden="true" />
				<span>Requirements</span>
				<span className="session-requirements-count">{items.length}</span>
				<ChevronRight size={12} className="session-activity-chevron" />
			</summary>
			<ol>
				{items.map((item, index) => (
					// Items can repeat; their place in the list is their identity.
					// biome-ignore lint/suspicious/noArrayIndexKey: ordered static list
					<li key={index}>{item}</li>
				))}
			</ol>
		</details>
	);
}

const VERDICT_LABEL = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

/** A review or attempt loop record as one compact verdict row that opens to its findings. */
export function CheckVerdictCard({
	summary,
	nested = false,
}: {
	summary: CheckSummary;
	nested?: boolean;
}) {
	const Icon =
		summary.verdict === "pass"
			? ShieldCheck
			: summary.verdict === "fail"
				? ShieldX
				: ShieldQuestion;
	const name = summary.kind === "review" ? "Review" : "Attempt";
	const title = summary.round
		? `${name} ${summary.round}${summary.maxRounds ? ` of ${summary.maxRounds}` : ""}`
		: summary.kind === "review"
			? "Independent review"
			: "Attempts";
	const latest =
		summary.kind === "attempts"
			? (summary.rounds.find((round) => round.kept) ?? summary.rounds.at(-1))
			: summary.rounds.at(-1);
	const facts = [
		latest?.findings
			? `${latest.findings} finding${latest.findings === 1 ? "" : "s"}`
			: null,
		summary.tests
			? `${summary.tests.run} test${summary.tests.run === 1 ? "" : "s"}${summary.tests.failed ? `, ${summary.tests.failed} failed` : ""}`
			: summary.failingTests.length
				? `${summary.failingTests.length} failing test${summary.failingTests.length === 1 ? "" : "s"}`
				: null,
		latest?.responses ?? null,
		summary.kind === "attempts" && latest?.kept
			? `kept attempt ${latest.n}`
			: null,
	].filter(Boolean);
	return (
		<details
			className="session-activity session-check"
			data-kind="check"
			data-verdict={summary.verdict ?? "none"}
			data-nested={nested ? "true" : undefined}
		>
			<summary>
				<Icon
					className="session-check-icon"
					size={14}
					strokeWidth={1.5}
					aria-hidden="true"
				/>
				<span className="session-activity-title">
					<span className="session-tool-verb">{title}</span>
					<span className="session-check-verdict">
						{summary.verdict
							? VERDICT_LABEL[summary.verdict]
							: summary.ended
								? "Stopped"
								: "No verdict"}
					</span>
					{facts.length ? (
						<span className="session-tool-note">{facts.join(" · ")}</span>
					) : null}
				</span>
				<ChevronRight size={12} className="session-activity-chevron" />
			</summary>
			<div className="session-command-detail session-check-detail">
				{summary.rounds.length > 1 ? (
					<ul className="session-check-rounds">
						{summary.rounds.map((round) => (
							<li key={round.n} data-verdict={round.verdict ?? "none"}>
								{name} {round.n}: {round.text}
							</li>
						))}
					</ul>
				) : null}
				{summary.findings.length ? (
					<>
						<p className="session-activity-meta">Findings</p>
						<ul className="session-check-findings">
							{summary.findings.map((finding) => (
								<li key={finding}>{finding}</li>
							))}
						</ul>
					</>
				) : null}
				{summary.failingTests.length ? (
					<>
						<p className="session-activity-meta">Failing tests</p>
						<ul className="session-check-findings">
							{summary.failingTests.map((test) => (
								<li key={test.name}>
									{test.name}
									{test.command ? <code>{test.command}</code> : null}
								</li>
							))}
						</ul>
					</>
				) : null}
				{summary.ended ? <p>Stopped: {summary.ended}</p> : null}
				{summary.selection ? <p>Selection: {summary.selection}</p> : null}
				{summary.spend ? (
					<p className="session-activity-meta">{summary.spend}</p>
				) : null}
			</div>
		</details>
	);
}

const capitalized = (text: string) =>
	text.charAt(0).toUpperCase() + text.slice(1);

/** An agent or agent_send call: role, title, model and status, opening to the brief and report. */
export function AgentCallView({
	item,
	call,
	titleClass,
	nested = false,
	live = false,
	onOpenFile,
}: {
	item: DynamicToolCallItem;
	call: AgentCall;
	titleClass: string;
	nested?: boolean;
	live?: boolean;
	onOpenFile?: (path: string) => void;
}) {
	// A helper goes by its task and a kind tag (helper-names.ts), not its role.
	const helper =
		call.tool === "agent" && !call.explore ? helperCallLabel(call) : null;
	const verb =
		call.tool === "agent"
			? call.explore
				? "Explore round"
				: "Started"
			: call.stop
				? "Stopped agent"
				: call.explore
					? "Explore round for agent"
					: "Messaged agent";
	const target = call.tool === "agent" ? (helper?.name ?? call.title) : call.id;
	// The subagent card below the call shows its live status; the call row only
	// adds what it alone knows: a failure, a waited reader's outcome, a round.
	const status =
		item.status === "failed"
			? "Failed"
			: call.status
				? capitalized(call.status)
				: undefined;
	return (
		<details
			className="session-activity"
			data-kind="agentCall"
			data-status={item.status}
			data-live={live ? "true" : undefined}
			data-nested={nested ? "true" : undefined}
		>
			<summary>
				<ActivityIcon glyph={item.status === "failed" ? "error" : "agent"} />
				<span className={titleClass}>
					<span className="session-tool-verb">{verb}</span>
					{target ? (
						call.tool === "agent" ? (
							<span className="session-tool-target">{target}</span>
						) : (
							<code className="session-tool-target">{target}</code>
						)
					) : null}
					{call.tool === "agent" && call.model ? (
						<span className="session-tool-note">{call.model}</span>
					) : null}
				</span>
				{helper?.tag ? (
					<span className="agent-row-tag">{helper.tag}</span>
				) : null}
				<ChevronRight size={12} className="session-activity-chevron" />
				{status ? (
					<span className="session-activity-status">{status}</span>
				) : null}
			</summary>
			{call.brief || call.message ? (
				<div className="session-command-detail">
					<p className="session-activity-meta">
						{call.brief ? "Brief" : "Message"}
					</p>
					<AgentMarkdown
						text={(call.brief ?? call.message) as string}
						onOpenFile={onOpenFile}
					/>
				</div>
			) : null}
			{call.report ? (
				<div className="session-command-detail">
					<p className="session-activity-meta">
						Report{call.reportMeta ? ` · ${call.reportMeta}` : ""}
					</p>
					<AgentMarkdown text={call.report} onOpenFile={onOpenFile} />
				</div>
			) : null}
			{call.budget || call.note || call.modelNotice ? (
				<div className="session-activity-meta session-agent-meta">
					{[
						call.id && call.tool === "agent" ? `Agent ${call.id}` : null,
						call.budget,
						call.note,
						call.modelNotice,
					]
						.filter(Boolean)
						.join(" · ")}
				</div>
			) : null}
			{!item.input && !item.output ? (
				<p>Details were not recorded for this call.</p>
			) : null}
		</details>
	);
}
