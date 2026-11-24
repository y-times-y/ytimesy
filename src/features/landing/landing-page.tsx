import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Check,
	CornerDownRight,
	Terminal,
	X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Wordmark } from "#/components/brand/wordmark";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { threadColor } from "#/domain/thread-color";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
import { ScoreCostChart } from "#/features/blog/score-cost-chart";
import { ClaudeMark } from "#/features/sessions/claude-mark";
import { CodexMark } from "#/features/sessions/codex-mark";
import { GrokMark } from "#/features/sessions/grok-mark";
import { ModelProviderLogo } from "#/features/sessions/model-provider-logo";
import { GithubMark } from "#/features/workspace/github-mark";
import { ThreadMark } from "#/features/workspace/thread-mark";
import { DISCORD_URL } from "./community-links";
import { DiscordMark } from "./discord-mark";
import {
	BENCH_COLUMNS,
	BENCH_ROWS,
	BENCHMARK,
	HARNESS_POST_PATH,
} from "./landing-facts";
import "./landing-page.css";
import { PREVIEW } from "./preview/preview.gen";
import "./preview/preview-styles.gen";

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
				<nav className="landing-nav" aria-label="Resources and account">
					<a
						className="landing-github-link"
						href="https://github.com/y-times-y/ytimesy"
						target="_blank"
						rel="noreferrer"
						aria-label="ytimesy on GitHub (open source)"
						title="ytimesy on GitHub (open source)"
					>
						<GithubMark size={18} />
						<span>GitHub</span>
					</a>
					<a
						className="landing-github-link landing-discord-link"
						href={DISCORD_URL}
						target="_blank"
						rel="noreferrer"
						aria-label="Join the ytimesy Discord"
						title="Join the ytimesy Discord"
					>
						<DiscordMark size={18} />
						<span>Discord</span>
					</a>
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
					<h1 id="landing-title">Your Super agent runs the whole project</h1>
					<p className="landing-lede">
						Threads work in parallel on their own cloud machines. The Super
						agent keeps up with every one, stays quiet until you are needed, and
						tells you what changed in a short digest.
					</p>
					<SignUp
						className="landing-button landing-button-large"
						label="Start building"
					/>
					<div className="landing-shot-frame">
						<AppPreview />
					</div>
				</section>
				<Features />
				<Models />
				<Benchmark />
				<section className="landing-close" aria-labelledby="landing-close">
					<h2 id="landing-close">Build Ambitious Software</h2>
					<p className="landing-dim landing-close-note">
						Open source under the MIT licence.
					</p>
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

/**
 * The app as it is today: the product's own components, rendered with demo
 * data by `pnpm previews` (preview/preview-demo.tsx). Plain markup, no app
 * script on this page; inert so none of it takes focus or clicks.
 */
function AppPreview() {
	return (
		<div
			className="landing-preview"
			role="img"
			aria-label="The ytimesy app: a Threads list grouped into Needs you, Working and Recently finished, the Super agent's chat with a canvas, and an Overview of what needs you."
			inert
			// biome-ignore lint/security/noDangerouslySetInnerHtml: markup generated from our own components by pnpm previews, never user input
			dangerouslySetInnerHTML={{ __html: PREVIEW.app }}
		/>
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

export function Models() {
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
							Your OpenAI, Anthropic, Google (including Gemini 4 Neon) or xAI
							key, or one OpenRouter key for all of them.
						</p>
					</div>
				</li>
				<li className="model-card">
					<span className="model-logos">
						<CornerDownRight size={26} strokeWidth={1.5} aria-hidden="true" />
					</span>
					<div>
						<h3>Automatic failover</h3>
						<p>
							When a plan runs out, the thread continues on the next model you
							allowed. It goes back when the plan resets.
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

/** Demo threads for the fleet tile: the sidebar's own naming (<project>-<number>). */
const FLEET = [
	{
		number: 1,
		name: "web-1",
		task: "Upgrade the date library",
		command: "pnpm test dates",
		done: true,
	},
	{
		number: 3,
		name: "web-3",
		task: "Dark mode toggle",
		command: "pnpm test settings",
		done: false,
	},
	{
		number: 5,
		name: "web-5",
		task: "Billing page",
		command: "pnpm build",
		done: false,
	},
] as const;

const MEMORIES = [
	"Use pnpm, not npm",
	"Every API route checks the session first",
	"Keep commits small, one change each",
];

export function Features() {
	return (
		<section className="landing-features" aria-labelledby="landing-features">
			<h2 id="landing-features">What's inside.</h2>
			<ul className="tiles">
				<Tile
					title="A Super agent for every project: one place to live"
					className="tile-full"
				>
					<div className="tv-super">
						<p className="tv-super-copy">
							It keeps up with every thread, stays quiet by default, and answers
							with a short digest. A question a thread asked is answered right
							there, and a stuck thread is retried or archived from the same
							chat.
						</p>
						<div
							className="tv-super-overview"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: markup generated from our own components by pnpm previews, never user input
							dangerouslySetInnerHTML={{ __html: PREVIEW.overview }}
						/>
					</div>
				</Tile>
				<Tile
					title="Threads run in parallel, each on its own cloud machine, and can message each other"
					className="tile-full"
				>
					<div className="tv-fleet">
						<div className="tv-vm tv-vm-main">
							<p className="tv-vm-head">
								<span className="tv-main-dot" />
								<strong>Super agent</strong>
								<span>web</span>
							</p>
							<p className="tv-vm-line">Reads every thread</p>
							<p className="tv-vm-line">Digest only when it matters</p>
						</div>
						<div className="tv-links" />
						<div className="tv-vms">
							{FLEET.map((thread) => (
								<div key={thread.name} className="tv-vm">
									<p className="tv-vm-head">
										<span
											className="tv-thread"
											style={
												{
													"--thread-color": threadColor({
														id: thread.name,
														threadNumber: thread.number,
													}),
												} as CSSProperties
											}
										>
											<ThreadMark size={16} />
										</span>
										<strong>{thread.name}</strong>
										<span
											className="tv-vm-status"
											data-done={thread.done || undefined}
										>
											{thread.done ? <Check size={13} /> : <MatrixDotLoader />}
										</span>
									</p>
									<p className="tv-vm-task">{thread.task}</p>
									<p className="tv-vm-term">
										<Terminal size={12} />
										{thread.command}
									</p>
								</div>
							))}
						</div>
					</div>
				</Tile>
				<Tile
					title="Canvases: live pages you can annotate"
					className="tile-wide"
				>
					<p className="tv-copy">
						A thread shows its work as a rendered page next to the chat. Pin a
						note on any element and send it back as feedback.
					</p>
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
				<Tile
					title="GitHub pull requests and issues, in the app"
					className="tile-wide"
				>
					<p className="tv-copy">
						Review a pull request or pick up an issue without leaving the
						workspace. Each thread's pull request shows beside it in the list.
					</p>
				</Tile>
				<Tile title="Remembers how you work">
					<div className="tv-memory">
						{MEMORIES.map((line) => (
							<p key={line} className="tv-memory-line">
								<span>{line}</span>
							</p>
						))}
					</div>
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
					href="https://github.com/y-times-y/ytimesy"
					target="_blank"
					rel="noreferrer"
				>
					<GithubMark size={15} />
					Open source
					<ArrowUpRight size={13} aria-hidden="true" />
				</a>
				<a
					className="landing-harness-link"
					href={DISCORD_URL}
					target="_blank"
					rel="noreferrer"
				>
					<DiscordMark size={15} />
					Discord
					<ArrowUpRight size={13} aria-hidden="true" />
				</a>
				<Link to="/blog">Blog</Link>
				<Link to="/terms">Terms</Link>
				<Link to="/privacy">Privacy</Link>
				<Link to="/privacy" hash="choices">
					Cookie settings
				</Link>
				<a href="mailto:support@ytimesy.com">support@ytimesy.com</a>
			</nav>
		</footer>
	);
}
