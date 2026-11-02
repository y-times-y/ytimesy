import { createFileRoute, redirect } from "@tanstack/react-router";

/** The post's first address: send it to the published one. */
export const Route = createFileRoute("/blog/harness")({
	beforeLoad: () => {
		throw redirect({ to: "/blog/harness-1-0", statusCode: 301 });
	},
});
