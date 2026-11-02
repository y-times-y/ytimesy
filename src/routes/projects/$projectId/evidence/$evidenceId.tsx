import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { IdentityGate } from "#/features/auth/identity-gate";
import { getEvidencePage } from "#/features/evidence/evidence.fn";
import {
	EvidenceDetail,
	EvidenceSummary,
} from "#/features/evidence/evidence-view";
import { LandingHeader, SiteFooter } from "#/features/landing/landing-page";

/** Pull request evidence, linked from the PR description; signed-in project owner only. */
export const Route = createFileRoute(
	"/projects/$projectId/evidence/$evidenceId",
)({
	loader: async ({ params }) => {
		const page = await getEvidencePage({ data: params });
		// Someone else's (or an expired) capture is indistinguishable from none.
		if (page.signedIn && !page.evidence) throw notFound();
		return page;
	},
	head: () => ({
		meta: [
			{ title: "Pull request evidence · ytimesy" },
			{ name: "robots", content: "noindex" },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	component: EvidenceRoute,
});

function EvidenceRoute() {
	const initial = Route.useLoaderData();
	return (
		<IdentityGate initialSignedIn={initial.signedIn}>
			<EvidenceContent />
		</IdentityGate>
	);
}

function EvidenceContent() {
	const params = Route.useParams();
	const initial = Route.useLoaderData();
	const load = useServerFn(getEvidencePage);
	const page = useQuery({
		queryKey: ["evidence-page", params.projectId, params.evidenceId],
		queryFn: () => load({ data: params }),
		initialData: initial.signedIn ? initial : undefined,
		refetchInterval: (query) =>
			query.state.data?.evidence?.status === "capturing" ? 10_000 : false,
	});
	const evidence = page.data?.evidence;
	const context = page.data?.context;
	return (
		<div className="landing">
			<LandingHeader signedIn />
			<main className="evidence-main">
				{evidence ? (
					<>
						{context ? (
							<EvidenceSummary context={context} now={page.data?.now} />
						) : null}
						<EvidenceDetail
							evidence={evidence}
							captures={page.data?.captures}
						/>
					</>
				) : page.isPending ? (
					<p className="evidence-missing">Loading evidence</p>
				) : (
					<p className="evidence-missing">
						This evidence is not available. It may have expired, or it belongs
						to a project you do not have access to.
					</p>
				)}
			</main>
			<SiteFooter />
		</div>
	);
}
