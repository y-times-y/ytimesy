import { Link } from "@tanstack/react-router";
import {
	Check,
	GitPullRequest,
	Globe,
	Layers,
	LoaderCircle,
	Server,
	SquareTerminal,
} from "lucide-react";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
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
					<h1 id="landing-title">
						Coding agents
						<br />
						in their own cloud.
					</h1>
					<div className="landing-actions">
						<SignUp
							className="landing-button landing-button-large"
							label="Start building"
						/>
					</div>
					<ProductShot />
				</section>
				<Benchmark />
				<Features />
				<section className="landing-close" aria-labelledby="landing-close">
					<h2 id="landing-close">Hand it the next task.</h2>
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

/** The app at work, drawn in markup: chats, a turn, and its live preview. */
function ProductShot() {
	return (
		<div className="shot" aria-hidden="true">
			<div className="shot-bar">
				<span />
				<span />
				<span />
			</div>
			<div className="shot-body">
				<aside className="shot-sidebar">
					<p className="shot-heading">Working</p>
					<div className="shot-row shot-row-active">
						<span className="shot-shimmer">Add dark mode</span>
						<LoaderCircle size={12} className="shot-spin" />
					</div>
					<div className="shot-row">
						<span className="shot-shimmer">Speed up search</span>
						<LoaderCircle size={12} className="shot-spin" />
					</div>
					<p className="shot-heading">Done</p>
					<div className="shot-row">
						<span>Fix login redirect</span>
						<span className="shot-pr">
							<GitPullRequest size={12} />
							<Check size={12} />
						</span>
					</div>
					<div className="shot-row">
						<span>Upgrade the router</span>
						<span className="shot-pr shot-pr-merged">
							<GitPullRequest size={12} />
						</span>
					</div>
				</aside>
				<div className="shot-chat">
					<p className="shot-user">Add a dark mode toggle to settings.</p>
					<p className="shot-step">
						<SquareTerminal size={13} />
						Read 6 files
					</p>
					<p className="shot-step">
						<SquareTerminal size={13} />
						Edited 3 files
						<span className="shot-add">+48</span>
						<span className="shot-del">-12</span>
					</p>
					<p className="shot-step">
						<SquareTerminal size={13} />
						npm test
						<span className="shot-pass">214 passed</span>
					</p>
					<p className="shot-answer">
						Done. The toggle is in Settings and remembers your choice.
					</p>
					<div className="shot-prcard">
						<GitPullRequest size={14} />
						<span>PR #128 open</span>
						<span className="shot-pass">Checks passed</span>
					</div>
				</div>
				<div className="shot-preview">
					<div className="shot-url">
						<Globe size={11} />
						preview
					</div>
					<div className="shot-page">
						<div className="shot-page-nav" />
						<div className="shot-page-line shot-w70" />
						<div className="shot-page-line shot-w45" />
						<div className="shot-toggle">
							<span />
						</div>
						<div className="shot-page-grid">
							<span />
							<span />
							<span />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function Benchmark() {
	const slowest = Math.max(...BENCHMARK.agents.map((agent) => agent.minutes));
	const ours = BENCHMARK.agents.find((agent) => agent.ours);
	return (
		<section className="landing-bench" aria-labelledby="landing-bench-title">
			<h2 id="landing-bench-title">
				Same score.
				<br />
				<span className="landing-dim">A third less time.</span>
			</h2>
			<div className="bench-card">
				<div className="bench-head">
					<span>Minutes per task</span>
					{BENCHMARK.final ? null : (
						<span className="landing-chip landing-chip-small">Preliminary</span>
					)}
				</div>
				<ul className="bench-bars">
					{BENCHMARK.agents.map((agent) => (
						<li key={agent.name} data-ours={agent.ours || undefined}>
							<span className="bench-name">{agent.name}</span>
							<span className="bench-track">
								<span
									className="bench-fill"
									style={{ width: `${(agent.minutes / slowest) * 100}%` }}
								/>
							</span>
							<span className="bench-value">{agent.minutes.toFixed(1)}</span>
						</li>
					))}
				</ul>
				<div className="bench-stats">
					<div>
						<strong>{ours?.score.toFixed(1)}%</strong>
						<span>Score, on par</span>
					</div>
					<div>
						<strong>${BENCHMARK.costPerTask.ours.toFixed(2)}</strong>
						<span>Per task, similar cost</span>
					</div>
				</div>
				<p className="bench-setup">{BENCHMARK.setup}</p>
			</div>
		</section>
	);
}

const FEATURES = [
	{ icon: Server, title: "A cloud machine per chat" },
	{ icon: GitPullRequest, title: "Branches and pull requests" },
	{ icon: Globe, title: "Live previews" },
	{ icon: Layers, title: "Parallel sub-agents" },
] as const;

function Features() {
	return (
		<section className="landing-features" aria-labelledby="landing-features">
			<h2 id="landing-features">
				The agent we benchmark.
				<br />
				<span className="landing-dim">The agent you get.</span>
			</h2>
			<ul className="feature-grid">
				{FEATURES.map(({ icon: Icon, title }) => (
					<li key={title} className="feature-tile">
						<Icon size={20} strokeWidth={1.5} />
						<span>{title}</span>
					</li>
				))}
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
