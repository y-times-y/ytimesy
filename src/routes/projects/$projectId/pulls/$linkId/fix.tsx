import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { IdentityGate } from "#/features/auth/identity-gate";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
import {
	getPullRequestFixPage,
	startPullRequestFixChat,
} from "#/features/pull-requests/pull-request-fix.fn";

/**
 * "Fix with ytimesy", linked from the pull request description: the signed-in
 * project owner starts (or continues) the chat on the pull request's branch.
 * Starting takes a click, so opening the link alone never runs the agent.
 */
export const Route = createFileRoute("/projects/$projectId/pulls/$linkId/fix")({
	loader: async ({ params }) => {
		const page = await getPullRequestFixPage({ data: params });
		// Someone else's pull request is indistinguishable from none.
		if (page.signedIn && !page.pull) throw notFound();
		return page;
	},
	head: () => ({
		meta: [
			{ title: "Fix with ytimesy" },
			{ name: "robots", content: "noindex" },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	component: PullRequestFixRoute,
});

function PullRequestFixRoute() {
	const initial = Route.useLoaderData();
	return (
		<IdentityGate initialSignedIn={initial.signedIn}>
			<PullRequestFix />
		</IdentityGate>
	);
}

function PullRequestFix() {
	const params = Route.useParams();
	const { pull } = Route.useLoaderData();
	const start = useServerFn(startPullRequestFixChat);
	const [note, setNote] = useState("");
	// One id per page visit: a double click or retry continues the same request.
	const requestId = useRef(crypto.randomUUID());
	const run = useMutation({
		mutationFn: () =>
			start({
				data: {
					projectId: params.projectId,
					linkId: params.linkId,
					requestId: requestId.current,
					note,
				},
			}),
		onSuccess: (chat) =>
			window.location.assign(
				`/?${new URLSearchParams({ project: chat.projectId, chat: chat.sessionId })}`,
			),
	});
	return (
		<main className="evidence-shell">
			<nav className="evidence-nav">
				<YtimesyBrand />
			</nav>
			{pull ? (
				<section className="mx-auto grid w-full max-w-xl gap-3 px-4 py-8 text-sm">
					<h1 className="text-base font-medium">
						Fix pull request #{pull.number}
					</h1>
					<p className="text-muted-foreground">
						<a href={pull.url} rel="noreferrer" className="underline">
							{pull.fullName}#{pull.number}
						</a>{" "}
						· {pull.headRef} into {pull.baseRef}
					</p>
					<p className="text-muted-foreground">
						The agent works on the pull request's branch with its failing
						checks. Add what to change, or leave it empty to fix the failures.
					</p>
					<Textarea
						value={note}
						onChange={(event) => setNote(event.target.value)}
						placeholder="Optional: what should change"
						maxLength={6000}
						rows={4}
					/>
					<div className="flex items-center gap-3">
						<Button
							size="lg"
							disabled={run.isPending || run.isSuccess}
							onClick={() => run.mutate()}
						>
							{run.isPending || run.isSuccess
								? "Starting chat…"
								: "Start fix chat"}
						</Button>
						{run.error ? (
							<span className="text-destructive">{run.error.message}</span>
						) : null}
					</div>
				</section>
			) : (
				<p className="evidence-missing">
					This pull request is not available. It belongs to a project you do not
					have access to.
				</p>
			)}
		</main>
	);
}
