import { Link } from "@tanstack/react-router";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";

/** The auth route's optional search parameters, all unset. */
const NO_SEARCH = { error: undefined, redirectTo: undefined };

const FEATURES = [
	{
		title: "A real machine for every chat",
		body: "Each chat gets its own private cloud workspace with your GitHub repository checked out. The agent reads, edits, runs commands and tests there, not on your laptop.",
	},
	{
		title: "Bring your own model",
		body: "Connect your own model provider account or API key. You pay your provider directly for model usage; ytimesy never marks it up.",
	},
	{
		title: "Changes you review",
		body: "Work lands on its own branch and a pull request. Nothing is merged without you, and you can open the workspace's terminal, files and desktop at any time.",
	},
] as const;

/** What signed-out visitors see at `/`. Signed-in users get the app. */
export function LandingPage() {
	return (
		<div className="landing">
			<header className="landing-header">
				<YtimesyBrand />
				<nav className="landing-nav" aria-label="Account">
					<Link
						to="/auth/$path"
						params={{ path: "sign-in" }}
						search={NO_SEARCH}
					>
						Sign in
					</Link>
					<Link
						to="/auth/$path"
						params={{ path: "sign-up" }}
						search={NO_SEARCH}
						className="landing-button"
					>
						Sign up
					</Link>
				</nav>
			</header>
			<main className="landing-main">
				<section className="landing-hero" aria-labelledby="landing-title">
					<p className="landing-badge">Free beta — bring your own model</p>
					<h1 id="landing-title">
						Coding agents that work in their own cloud workspace.
					</h1>
					<p className="landing-lede">
						ytimesy runs an agent on a private cloud machine connected to your
						GitHub repository. It writes and tests the change, then opens a pull
						request for you to review.
					</p>
					<div className="landing-actions">
						<Link
							to="/auth/$path"
							params={{ path: "sign-up" }}
							search={NO_SEARCH}
							className="landing-button landing-button-large"
						>
							Get started free
						</Link>
						<Link
							to="/auth/$path"
							params={{ path: "sign-in" }}
							search={NO_SEARCH}
							className="landing-link-large"
						>
							Sign in
						</Link>
					</div>
				</section>
				<section className="landing-features" aria-label="How it works">
					{FEATURES.map((feature) => (
						<article key={feature.title} className="landing-feature">
							<h2>{feature.title}</h2>
							<p>{feature.body}</p>
						</article>
					))}
				</section>
				<section className="landing-beta" aria-labelledby="landing-beta-title">
					<h2 id="landing-beta-title">About the beta</h2>
					<p>
						During the beta, every account gets a monthly allowance of cloud
						machine minutes at no cost. Model usage is billed by the provider
						you connect. Things may change or break while we build; tell us at{" "}
						<a href="mailto:support@ytimesy.com">support@ytimesy.com</a>.
					</p>
				</section>
			</main>
			<SiteFooter />
		</div>
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
