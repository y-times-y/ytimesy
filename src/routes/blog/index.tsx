import { createFileRoute } from "@tanstack/react-router";
import { BlogIndex } from "#/features/blog/blog-pages";
import { SITE_ORIGIN } from "#/features/blog/posts";

export const Route = createFileRoute("/blog/")({
	head: () => ({
		meta: [
			{ title: "Blog · ytimesy" },
			{
				name: "description",
				content:
					"Notes from the team building ytimesy, the AI software engineer in the cloud.",
			},
		],
		links: [{ rel: "canonical", href: `${SITE_ORIGIN}/blog` }],
	}),
	component: BlogIndex,
});
