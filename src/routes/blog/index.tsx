import { createFileRoute } from "@tanstack/react-router";
import { BlogIndex } from "#/features/blog/blog-pages";
import { SITE_ORIGIN, sitePreviewMeta } from "#/features/blog/posts";

export const Route = createFileRoute("/blog/")({
	head: () => ({
		meta: [
			{ title: "Blog · ytimesy" },
			...sitePreviewMeta({
				title: "Blog · ytimesy",
				description:
					"Notes from the team building ytimesy, the AI software engineer in the cloud.",
				url: `${SITE_ORIGIN}/blog`,
			}),
		],
		links: [{ rel: "canonical", href: `${SITE_ORIGIN}/blog` }],
	}),
	component: BlogIndex,
});
