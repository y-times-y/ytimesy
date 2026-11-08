import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	BookmarkPlus,
	Camera,
	Check,
	CornerDownRight,
	Github,
	Terminal,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Wordmark } from "#/components/brand/wordmark";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { HELPER_COLORS } from "#/domain/helper-names";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
import { ScoreCostChart } from "#/features/blog/score-cost-chart";
import { AgentIcon } from "#/features/sessions/agent-icon";
import { ClaudeMark } from "#/features/sessions/claude-mark";
import { CodexMark } from "#/features/sessions/codex-mark";
import { GrokMark } from "#/features/sessions/grok-mark";
import { ModelProviderLogo } from "#/features/sessions/model-provider-logo";
import { AppShot, SHOT_HELPERS } from "./landing-app-shot";
import {
	BENCH_COLUMNS,
	BENCH_ROWS,
	BENCHMARK,
	HARNESS_POST_PATH,
} from "./landing-facts";
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

/**
 * The site's top bar: the landing page, 404 and evidence page. A signed-in
 * viewer gets a way into the app instead of Sign in / Get started.
 */
export function LandingHeader({ signedIn = false }: { signedIn?: boolean }) {
	return (
		<header className="landing-header">
			<div className="landing-header-inner">
				<YtimesyBrand />
				<nav className="landing-nav" aria-label="Account">
					{signedIn ? (
						<a className="landing-button" href="/">
							Open ytimesy
						</a>
					) : (
						<>
							<Link
								to="/auth/$path"
								params={{ path: "sign-in" }}
								search={NO_SEARCH}
							>
								Sign in
							</Link>
							<SignUp className="landing-button" label="Get started" />
						</>
					)}
				</nav>
			</div>
		</header>
	);
}

/** Any unknown address: the site's own header and footer around a short 404. */
export function NotFoundPage() {
	return (
		<div className="landing">
			<LandingHeader />
			<main>
				<section className="landing-404" aria-labelledby="not-found-title">
					<p className="landing-404-code" aria-hidden="true">
						404
					</p>
					<h1 id="not-found-title">This page doesn't exist</h1>
					<p className="landing-dim">
						It may have moved, or the link is wrong.
					</p>
					<div className="landing-404-actions">
						<a className="landing-button landing-button-large" href="/">
							Go to ytimesy
						</a>
						<Link className="landing-404-secondary" to="/blog">
							Read the blog
						</Link>
					</div>
				</section>
			</main>
			<SiteFooter />
		</div>
	);
}

export function LandingPage() {
	return (
		<div className="landing">
			<LandingHeader />
			<main>
				<section className="landing-hero" aria-labelledby="landing-title">
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
					<h2 id="landing-close">Build Ambitious Software</h2>
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

function Benchmark() {
	return (
		<section className="landing-bench" aria-labelledby="landing-bench-title">
			<h2 id="landing-bench-title">
				Terminal-Bench 4.0
				<br />
				<span className="landing-dim bench-sub">
					The ytimesy harness vs Codex, on the same model.
				</span>
			</h2>
			<div className="bench-card">
				{/* Scrolls sideways inside the card on a phone, never the page. */}
				<div className="bench-scroll">
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
								{BENCH_COLUMNS.map((run, index) => (
									<th
										key={run.job}
										scope="col"
										data-ours={index === 0 || undefined}
									>
										{run.agent}
										<small>GPT-6 Astra {run.effort}</small>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{BENCH_ROWS.map((row) => (
								<tr key={row.label}>
									<th scope="row">
										{row.label}
										<small>{row.detail}</small>
									</th>
									{row.cells.map((cell, index) => (
										<td
											key={BENCH_COLUMNS[index].job}
											data-ours={index === 0 || undefined}
										>
											{cell.href ? (
												<a
													href={cell.href}
													className="bench-job"
													target="_blank"
													rel="noreferrer"
												>
													{cell.value}
												</a>
											) : (
												cell.value
											)}
											{cell.ci ? <small>{cell.ci}</small> : null}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="bench-note">{BENCHMARK.timeNote}</p>
				<figure className="bench-chart">
					<figcaption className="bench-chart-head">
						<span>Score vs cost</span>
						<span className="landing-dim">Up and to the right is better</span>
					</figcaption>
					<ScoreCostChart />
				</figure>
				<div className="bench-foot">
					<span>{BENCHMARK.setup}</span>
					<span className="bench-links">
						{BENCHMARK.runUrl ? (
							<a href={BENCHMARK.runUrl} target="_blank" rel="noreferrer">
								See the run
								<ArrowUpRight size={13} />
							</a>
						) : null}
					</span>
				</div>
			</div>
			<p className="bench-writeup">
				<a href={HARNESS_POST_PATH}>
					<span className="bench-writeup-read">
						For more details, read the post
					</span>
					Introducing ytimesy harness 1.0
				</a>
			</p>
		</section>
	);
}

/** Every model maker the model picker lists (src/domain/api-model-list.ts), then OpenRouter. */
const API_PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"x-ai",
	"deepseek",
	"qwen",
	"moonshotai",
	"meta",
	"z-ai",
	"openrouter",
];

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
					<div>
						<h3>Your ChatGPT subscription</h3>
						<p>Codex subscription, on our harness.</p>
					</div>
				</li>
				<li className="model-card">
					<span className="model-logos">
						<ClaudeMark size={30} />
					</span>
					<div>
						<h3>Your Claude subscription</h3>
						<p>Pro or Max, through the Claude Agent SDK.</p>
					</div>
				</li>
				<li className="model-card">
					<span className="model-logos">
						<GrokMark size={26} />
					</span>
					<div>
						<h3>Your Grok subscription</h3>
						<p>SuperGrok or X subscription, on our harness.</p>
					</div>
				</li>
				<li className="model-card">
					<span className="model-logos model-logos-many">
						{API_PROVIDERS.map((provider) => (
							<ModelProviderLogo key={provider} provider={provider} size={26} />
						))}
					</span>
					<div>
						<h3>Your API keys</h3>
						<p>
							Your OpenAI, Anthropic, Google or xAI key, or one OpenRouter key
							for all of them.
						</p>
					</div>
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
			<span role="img" aria-label="Y times Y">
				<Wordmark size={18} />
			</span>
			<nav aria-label="Resources, legal and support">
				<a
					className="landing-harness-link"
					href="https://github.com/y-times-y/harness"
					target="_blank"
					rel="noreferrer"
				>
					<Github size={15} aria-hidden="true" />
					Open-source harness
					<ArrowUpRight size={13} aria-hidden="true" />
				</a>
				<Link to="/blog">Blog</Link>
				<Link to="/terms">Terms</Link>
				<Link to="/privacy">Privacy</Link>
				<a href="mailto:support@ytimesy.com">support@ytimesy.com</a>
			</nav>
		</footer>
	);
}
