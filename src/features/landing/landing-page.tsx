import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Brain,
	Check,
	GitPullRequest,
	Hammer,
	Search,
	SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
import { AppShot } from "./landing-app-shot";
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
					<h1 id="landing-title">Cloud coding agent.</h1>
					<SignUp
						className="landing-button landing-button-large"
						label="Start building"
					/>
					<div className="landing-shot-frame">
						<AppShot />
					</div>
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

type Metric = {
	label: string;
	verdict: string;
	ours: number;
	codex: number;
	format: (value: number) => string;
};

function Benchmark() {
	const { ours, codex } = BENCHMARK;
	const lessTime = Math.round((1 - ours.minutes / codex.minutes) * 100);
	const metrics: Metric[] = [
		{
			label: "Time per task",
			verdict: `${lessTime}% less`,
			ours: ours.minutes,
			codex: codex.minutes,
			format: (value) => `${value.toFixed(1)} min`,
		},
		{
			label: "Score",
			verdict: "On par",
			ours: ours.score,
			codex: codex.score,
			format: (value) => `${value.toFixed(1)}%`,
		},
		{
			label: "Cost per task",
			verdict: "Similar",
			ours: ours.cost,
			codex: codex.cost,
			format: (value) => `$${value.toFixed(2)}`,
		},
	];
	return (
		<section className="landing-bench" aria-labelledby="landing-bench-title">
			<h2 id="landing-bench-title">
				Same model. Same score.
				<br />
				<span className="landing-dim">A third less time.</span>
			</h2>
			<div className="bench-card">
				<div className="bench-legend">
					<span data-ours="true">ytimesy</span>
					<span>Codex</span>
					{BENCHMARK.final ? null : (
						<span className="landing-chip landing-chip-small">Preliminary</span>
					)}
				</div>
				<div className="bench-metrics">
					{metrics.map((metric) => {
						const top = Math.max(metric.ours, metric.codex);
						return (
							<div key={metric.label} className="bench-metric">
								<div className="bench-metric-head">
									<span>{metric.label}</span>
									<strong>{metric.verdict}</strong>
								</div>
								{(
									[
										["ytimesy", metric.ours, true],
										["Codex", metric.codex, false],
									] as const
								).map(([name, value, isOurs]) => (
									<div
										key={name}
										className="bench-bar"
										data-ours={isOurs || undefined}
									>
										<span className="bench-track">
											<span
												className="bench-fill"
												style={{ width: `${(value / top) * 100}%` }}
											/>
										</span>
										<span className="bench-value">{metric.format(value)}</span>
									</div>
								))}
							</div>
						);
					})}
				</div>
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

function Features() {
	return (
		<section className="landing-features" aria-labelledby="landing-features">
			<h2 id="landing-features">
				Not just a model in the cloud.
				<br />
				<span className="landing-dim">Our own harness, end to end.</span>
			</h2>
			<ul className="tiles">
				<Tile title="Remembers your project" className="tile-wide">
					<div className="tv-memory">
						{[
							"Run tests with pnpm test, not npm",
							"Theme colors live in tokens.css",
							"API routes need an auth check",
						].map((line) => (
							<p key={line}>
								<Brain size={14} />
								{line}
							</p>
						))}
					</div>
				</Tile>
				<Tile title="Parallel sub-agents">
					<div className="tv-helpers">
						{(
							[
								["build-1", "tv-blue", Hammer, 100],
								["build-2", "tv-pink", Hammer, 72],
								["research-1", "tv-amber", Search, 48],
							] as const
						).map(([name, tone, Icon, done]) => (
							<p key={name}>
								<Icon size={13} className={tone} />
								<span>{name}</span>
								<span className="tv-lane">
									<span style={{ width: `${done}%` }} className={tone} />
								</span>
							</p>
						))}
					</div>
				</Tile>
				<Tile title="Opens the pull request">
					<div className="tv-pr">
						<p>
							<GitPullRequest size={15} className="tv-green" />
							<strong>#128</strong>
							<span>ytimesy/dark-mode</span>
						</p>
						<p className="tv-pr-meta">
							<span className="tv-green">
								<Check size={12} />
								Checks passed
							</span>
							<span>Ready to merge</span>
						</p>
					</div>
				</Tile>
				<Tile title="Its own cloud machine" className="tile-wide">
					<div className="tv-terminal">
						<p>
							<SquareTerminal size={12} />
							pnpm install
						</p>
						<p className="tv-dim">Done in 3.1s</p>
						<p>
							<SquareTerminal size={12} />
							pnpm test
						</p>
						<p className="tv-green">412 passed</p>
					</div>
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
