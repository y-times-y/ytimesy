import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	BookmarkPlus,
	Camera,
	Check,
	CornerDownRight,
	Terminal,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { HELPER_COLORS } from "#/domain/helper-names";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
import { AgentIcon } from "#/features/sessions/agent-icon";
import { CodexMark } from "#/features/sessions/codex-mark";
import { ModelProviderLogo } from "#/features/sessions/model-provider-logo";
import { AppShot, SHOT_HELPERS } from "./landing-app-shot";
import { BENCHMARK } from "./landing-facts";
import "./landing-page.css";

/** The auth route's optional search parameters, all unset. */
const NO_SEARCH = { error: undefined, redirectTo: undefined };

function SignUp({ className, label }: { className: string; label: string }) {
	return (
		<Link
			to="/auth/$path"
			params={{ path: "sign-up" }}
			search={NO_SEARCH}
			className={className}
		>
			{label}
		</Link>
	);
}

/** What signed-out visitors see at `/`. Signed-in users get the app. */
export function LandingPage() {
	return (
		<div className="landing">
			<header className="landing-header">
				<div className="landing-header-inner">
					<YtimesyBrand />
					<nav className="landing-nav" aria-label="Account">
						<Link
							to="/auth/$path"
							params={{ path: "sign-in" }}
							search={NO_SEARCH}
						>
							Sign in
						</Link>
						<SignUp className="landing-button" label="Get started" />
					</nav>
				</div>
			</header>
			<main>
				<section className="landing-hero" aria-labelledby="landing-title">
					<span className="landing-chip">Free beta</span>
					<h1 id="landing-title">AI Software Engineer in the Cloud</h1>
					<SignUp
						className="landing-button landing-button-large"
						label="Start building"
					/>
					<div className="landing-shot-frame">
						<AppShot />
					</div>
				</section>
				<Benchmark />
				<Models />
				<Features />
				<section className="landing-close" aria-labelledby="landing-close">
					<h2 id="landing-close">
						Build Ambitious Software Without Constraints
					</h2>
					<SignUp
						className="landing-button landing-button-large"
						label="Start building"
					/>
				</section>
			</main>
			<SiteFooter />
		</div>
	);
}

type Row = {
	label: string;
	detail: string;
	ours: string;
	codex: string;
	/** Which side reads better, if either. */
	lead: "ours" | "codex" | null;
};

function Benchmark() {
	const { ours, codex } = BENCHMARK;
	const rows: Row[] = [
		{
			label: "Terminal-Bench 4",
			detail: "Tasks solved",
			ours: `${ours.score.toFixed(1)}%`,
			codex: `${codex.score.toFixed(1)}%`,
			lead: null,
		},
		{
			label: "Time per task",
			detail: "Agent working time",
			ours: `${ours.minutes.toFixed(1)} min`,
			codex: `${codex.minutes.toFixed(1)} min`,
			lead: "ours",
		},
		{
			label: "Cost per task",
			detail: "At OpenAI list prices",
			ours: `$${ours.cost.toFixed(2)}`,
			codex: `$${codex.cost.toFixed(2)}`,
			lead: null,
		},
	];
	return (
		<section className="landing-bench" aria-labelledby="landing-bench-title">
			<h2 id="landing-bench-title">
				Our own harness.
				<br />
				<span className="landing-dim">
					Same model as Codex. A third less time.
				</span>
			</h2>
			<div className="bench-card">
				<table className="bench-table">
					<thead>
						<tr>
							<th scope="col">
								{BENCHMARK.final ? null : (
									<span className="landing-chip landing-chip-small">
										Preliminary
									</span>
								)}
							</th>
							<th scope="col" data-ours="true">
								ytimesy
								<small>GPT-6 Astra xhigh</small>
							</th>
							<th scope="col">
								Codex
								<small>GPT-6 Astra xhigh</small>
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.label}>
								<th scope="row">
									{row.label}
									<small>{row.detail}</small>
								</th>
								<td
									data-ours="true"
									data-lead={row.lead === "ours" || undefined}
								>
									{row.ours}
								</td>
								<td data-lead={row.lead === "codex" || undefined}>
									{row.codex}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className="bench-foot">
					<span>{BENCHMARK.setup}</span>
					{BENCHMARK.runUrl ? (
						<a href={BENCHMARK.runUrl} target="_blank" rel="noreferrer">
							See the run
							<ArrowUpRight size={13} />
						</a>
					) : null}
				</div>
			</div>
		</section>
	);
}

const API_PROVIDERS = ["openai", "anthropic", "google", "openrouter"];

function Models() {
	return (
		<section className="landing-models" aria-labelledby="landing-models">
			<h2 id="landing-models">
				Bring your own model.
				<br />
				<span className="landing-dim">On our harness.</span>
			</h2>
			<ul className="models">
				<li className="model-card">
					<span className="model-logos">
						<CodexMark size={30} />
					</span>
					<h3>Your Codex subscription</h3>
				</li>
				<li className="model-card">
					<span className="model-logos">
						{API_PROVIDERS.map((provider) => (
							<ModelProviderLogo key={provider} provider={provider} size={26} />
						))}
					</span>
					<h3>Your API keys</h3>
				</li>
			</ul>
		</section>
	);
}

function Tile({
	title,
	className,
	children,
}: {
	title: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<li className={`tile ${className ?? ""}`}>
			<div className="tile-visual" aria-hidden="true">
				{children}
			</div>
			<h3>{title}</h3>
		</li>
	);
}

const FLEET = [
	{ ...SHOT_HELPERS[0], command: "pnpm test tokens", done: true },
	{ ...SHOT_HELPERS[1], command: "pnpm test settings", done: false },
	{
		name: "build-3",
		icon: SHOT_HELPERS[0].icon,
		color: HELPER_COLORS[1],
		task: "Dark mode emails",
		command: "pnpm build",
		done: false,
	},
] as const;

/** A real run: our own front page, tested and recorded in Chrome (public/landing). */
const RUN_STEPS = [
	"Open the front page",
	"Scroll to the benchmark",
	"Open Sign in",
	"Screenshot each step",
];
const EVIDENCE_SHOTS = ["1-front", "2-benchmark", "3-signin"];

const MEMORIES = [
	"Use pnpm, not npm",
	"Every API route checks the session first",
	"Keep commits small, one change each",
];

function Features() {
	return (
		<section className="landing-features" aria-labelledby="landing-features">
			<h2 id="landing-features">What's inside.</h2>
			<ul className="tiles">
				<Tile
					title="Agents work in parallel, each in its own machine"
					className="tile-full"
				>
					<div className="tv-fleet">
						<div className="tv-vm tv-vm-main">
							<p className="tv-vm-head">
								<span className="tv-main-dot" />
								<strong>Main</strong>
								<span>web</span>
							</p>
							<p className="tv-vm-line">Splits the work</p>
							<p className="tv-vm-line">Reviews each patch</p>
						</div>
						<div className="tv-links" />
						<div className="tv-vms">
							{FLEET.map((vm) => (
								<div key={vm.name} className="tv-vm">
									<p className="tv-vm-head">
										<AgentIcon icon={vm.icon} color={vm.color} />
										<strong>{vm.name}</strong>
										<span
											className="tv-vm-status"
											data-done={vm.done || undefined}
										>
											{vm.done ? <Check size={13} /> : <MatrixDotLoader />}
										</span>
									</p>
									<p className="tv-vm-task">{vm.task}</p>
									<p className="tv-vm-term">
										<Terminal size={12} />
										{vm.command}
									</p>
								</div>
							))}
						</div>
					</div>
				</Tile>
				<Tile title="Tests in a real browser" className="tile-wide">
					<div className="tv-run">
						<div className="tv-run-video">
							<p className="tv-browser-bar">
								<span />
								<span />
								<span />
								<span className="tv-url">localhost:8793</span>
								<span className="tv-rec">
									<span />
									REC
								</span>
							</p>
							<video
								src="/landing/run.mp4"
								poster="/landing/poster.jpg"
								autoPlay
								muted
								loop
								playsInline
								preload="metadata"
							/>
						</div>
						<ol className="tv-run-steps">
							{RUN_STEPS.map((step) => (
								<li key={step}>
									<Check size={13} strokeWidth={2.6} />
									{step}
								</li>
							))}
						</ol>
					</div>
				</Tile>
				<Tile title="Fixes failing checks on its own">
					<div className="tv-checks">
						<p data-state="failed">
							<X size={13} strokeWidth={2.6} />
							test
							<span>failed</span>
						</p>
						<p className="tv-wake">
							<CornerDownRight size={13} />
							Picked up by the chat
						</p>
						<p data-state="passed">
							<Check size={13} strokeWidth={2.6} />
							test
							<span>passed</span>
						</p>
					</div>
				</Tile>
				<Tile title="Remembers how you work">
					<div className="tv-memory">
						<p className="tv-memory-head">
							<BookmarkPlus size={14} strokeWidth={1.5} />
							Saved 3 memories
						</p>
						{MEMORIES.map((line) => (
							<p key={line} className="tv-memory-line">
								<span>{line}</span>
								<span className="tv-memory-meta">
									MEMORY.md
									<span>Undo</span>
								</span>
							</p>
						))}
					</div>
				</Tile>
				<Tile title="Screenshots and video in your PR" className="tile-wide">
					<section className="evidence-card" data-status="captured">
						<header className="evidence-header">
							<Camera size={14} />
							<strong>Evidence for web#131</strong>
							<span className="evidence-status" data-status="captured">
								Captured
							</span>
						</header>
						<div className="evidence-body">
							<p className="evidence-note">
								3 screenshots, 9 s screen recording
							</p>
							<ul className="evidence-thumbnails">
								{EVIDENCE_SHOTS.map((shot) => (
									<li key={shot}>
										<img src={`/landing/${shot}.webp`} alt="" loading="lazy" />
									</li>
								))}
							</ul>
						</div>
					</section>
				</Tile>
			</ul>
		</section>
	);
}

export function SiteFooter() {
	return (
		<footer className="landing-footer">
			<span>ytimesy</span>
			<nav aria-label="Legal and support">
				<Link to="/terms">Terms</Link>
				<Link to="/privacy">Privacy</Link>
				<a href="mailto:support@ytimesy.com">support@ytimesy.com</a>
			</nav>
		</footer>
	);
}
