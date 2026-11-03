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

/** Link-preview tags (Open Graph and X) with the harness post's banner as the card. */
export function sitePreviewMeta({
	title,
	description,
	url,
	image: imagePath = HARNESS_POST.banner,
	imageAlt = HARNESS_POST.bannerAlt,
}: {
	title: string;
	description: string;
	url: string;
	/** A 2400 x 1260 card under public/; the harness post's banner by default. */
	image?: string;
	imageAlt?: string;
}) {
	const image = `${SITE_ORIGIN}${imagePath}`;
	return [
		{ name: "description", content: description },
		{ property: "og:type", content: "website" },
		{ property: "og:site_name", content: "ytimesy" },
		{ property: "og:title", content: title },
		{ property: "og:description", content: description },
		{ property: "og:url", content: url },
		{ property: "og:image", content: image },
		{ property: "og:image:width", content: "2400" },
		{ property: "og:image:height", content: "1260" },
		{ property: "og:image:alt", content: imageAlt },
		{ name: "twitter:card", content: "summary_large_image" },
		{ name: "twitter:title", content: title },
		{ name: "twitter:description", content: description },
		{ name: "twitter:image", content: image },
	];
}

/** The front page's preview: what a shared ytimesy.com link shows. */
/** The landing page's title in search results and link previews. */
export const SITE_TITLE = "ytimesy: AI software engineer in the cloud";

export const SITE_PREVIEW_META = sitePreviewMeta({
	title: SITE_TITLE,
	description:
		"Give it a task and it builds in its own cloud machine, then opens a pull request. Use your ChatGPT, Claude or Grok plan, or your API keys.",
	url: `${SITE_ORIGIN}/`,
	image: "/og/home-card.jpg",
	imageAlt:
		"ytimesy: AI Software Engineer in the Cloud. Runs on your ChatGPT, Claude or Grok plan, or your API keys.",
});
