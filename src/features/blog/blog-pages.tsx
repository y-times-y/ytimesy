import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import post from "#/content/blog/harness-1-0.html?raw";
import { BLOG_POSTS } from "./posts";
import { ScoreCostChart } from "./score-cost-chart";
import "./blog.css";

/** Where the chart goes in the post's HTML. */
const CHART_MARKER = "<!-- score-cost-chart -->";
const [POST_BEFORE_CHART, POST_AFTER_CHART] = post.split(CHART_MARKER);

/** The single Y mark, coloured for the page's light or dark theme. */
function BlogMark() {
	return (
		<svg viewBox="0 0 32 32" aria-hidden="true">
			<path
				d="M4 8h6v4l6 6 6-6V2h6v13l-9 9v6h-6v-6l-9-9V8Z"
				style={{ fill: "var(--mark-0, #242424)" }}
			/>
			<path
				d="m4 15 12 7v8h-3v-6l-9-9Z"
				style={{ fill: "var(--mark-1, #757575)" }}
			/>
			<path
				d="m16 22 12-7-9 9v6h-3v-8Z"
				style={{ fill: "var(--mark-2, #484848)" }}
			/>
			<path
				d="m4 8 6 4 6 6v4L4 15V8Z"
				style={{ fill: "var(--mark-3, #5B5B5B)" }}
			/>
			<path
				d="m22 12 6-10v13l-12 7v-4l6-6Z"
				style={{ fill: "var(--mark-4, #111111)" }}
			/>
		</svg>
	);
}

function BlogShell({ children }: { children: ReactNode }) {
	return (
		<div className="hx">
			<header className="hx-bar">
				<Link to="/" className="hx-brand" aria-label="ytimesy home">
					<BlogMark />
					<span>times</span>
					<BlogMark />
				</Link>
				<nav aria-label="Blog">
					<Link to="/blog">Blog</Link>
					<Link
						to="/auth/$path"
						params={{ path: "sign-in" }}
						search={{ error: undefined, redirectTo: undefined }}
					>
						Sign in
					</Link>
				</nav>
			</header>
			{children}
		</div>
	);
}

/** The post's own HTML (src/content/blog), our constant: no user input. */
function PostHtml({ html }: { html: string }) {
	return (
		<div
			style={{ display: "contents" }}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: the post's HTML is a constant in the repository.
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/** /blog/harness-1-0: the launch post. */
export function HarnessPost() {
	return (
		<BlogShell>
			<main>
				<PostHtml html={POST_BEFORE_CHART} />
				<figure>
					<div className="chart-head">
						<span className="ch-title">Score vs cost</span>
						<span className="ch-hint">Up and to the right is better</span>
					</div>
					<ScoreCostChart />
					<figcaption>
						Terminal-Bench 4.0 score against cost per attempt with GPT-6 Astra,
						cheaper to the right. Codex with GPT-6 Astra at xhigh and max from
						the official leaderboard; ytimesy, marked with its logo, is this run
						with GPT-6 Astra at xhigh. Hover a point for its values; click a
						point for its Harbor job.
					</figcaption>
				</figure>
				<PostHtml html={POST_AFTER_CHART} />
			</main>
		</BlogShell>
	);
}

/** /blog: every post, newest first. */
export function BlogIndex() {
	return (
		<BlogShell>
			<main className="hx-index">
				<h1>Blog</h1>
				<ul className="hx-list">
					{BLOG_POSTS.map((entry) => (
						<li key={entry.path}>
							<a href={entry.path}>
								<img
									src={entry.banner}
									alt=""
									width={1200}
									height={630}
									loading="lazy"
								/>
								<div>
									<h2>{entry.title}</h2>
									<p>{entry.description}</p>
									<time dateTime={entry.date}>{entry.dateLabel}</time>
								</div>
							</a>
						</li>
					))}
				</ul>
			</main>
		</BlogShell>
	);
}
