import { createFileRoute } from "@tanstack/react-router";
import { HarnessPost } from "#/features/blog/blog-pages";
import { HARNESS_POST as POST, SITE_ORIGIN } from "#/features/blog/posts";

const SOCIAL_TITLE = `${POST.title}: 58.5% on Terminal-Bench 4.0`;

export const Route = createFileRoute("/blog/harness-1-0")({
	head: () => ({
		meta: [
			{ title: POST.title },
			{ name: "description", content: POST.description },
			{ property: "og:type", content: "article" },
			{ property: "og:title", content: SOCIAL_TITLE },
			{ property: "og:description", content: POST.description },
			{ property: "og:url", content: `${SITE_ORIGIN}${POST.path}` },
			{ property: "og:image", content: `${SITE_ORIGIN}${POST.banner}` },
			{ property: "og:image:width", content: "2400" },
			{ property: "og:image:height", content: "1260" },
			{ property: "og:image:alt", content: POST.bannerAlt },
			{ name: "twitter:card", content: "summary_large_image" },
			{ name: "twitter:title", content: SOCIAL_TITLE },
			{ name: "twitter:description", content: POST.description },
			{ name: "twitter:image", content: `${SITE_ORIGIN}${POST.banner}` },
		],
		links: [
			{ rel: "canonical", href: `${SITE_ORIGIN}${POST.path}` },
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			// The diagrams' code font; the text uses the app's own Inter.
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap",
			},
		],
	}),
	component: HarnessPost,
});
