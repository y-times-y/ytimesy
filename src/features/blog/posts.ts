import { HARNESS_POST_PATH } from "#/features/landing/landing-facts";

/** The site's public address, for links that leave the page (og:image, canonical). */
export const SITE_ORIGIN = "https://ytimesy.com";

export type BlogPost = {
	path: string;
	title: string;
	/** ISO date, and how the post itself prints it. */
	date: string;
	dateLabel: string;
	description: string;
	banner: string;
	bannerAlt: string;
};

export const HARNESS_POST: BlogPost = {
	path: HARNESS_POST_PATH,
	title: "Introducing ytimesy harness 1.0",
	date: "2026-11-01",
	dateLabel: "11.01.26",
	description:
		"ytimesy scores 58.5% on Terminal-Bench 4.0 with GPT-6 Astra, and how its harness works: the lead agent and its tools, code mode, subagents, background commands and the clean-copy check.",
	banner: `${HARNESS_POST_PATH}/banner.jpg`,
	bannerAlt:
		"ytimesy: 58.5% on Terminal-Bench 4.0 with GPT-6 Astra at xhigh, against Codex at 58.2% with GPT-6 Astra max and 57.9% with GPT-6 Astra xhigh.",
};

/** Newest first. */
export const BLOG_POSTS: readonly BlogPost[] = [HARNESS_POST];
