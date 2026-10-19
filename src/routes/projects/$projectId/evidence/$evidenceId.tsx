import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { IdentityGate } from "#/features/auth/identity-gate";
import { YtimesyBrand } from "#/features/auth/onboarding-shell";
import { getEvidencePage } from "#/features/evidence/evidence.fn";
import { EvidenceDetail } from "#/features/evidence/evidence-view";

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
	return (
		<main className="evidence-shell">
			<nav className="evidence-nav">
				<YtimesyBrand />
			</nav>
			{evidence ? (
				<EvidenceDetail evidence={evidence} />
			) : page.isPending ? (
				<p className="evidence-missing">Loading evidence</p>
			) : (
				<p className="evidence-missing">
					This evidence is not available. It may have expired, or it belongs to
					a project you do not have access to.
				</p>
			)}
		</main>
	);
}
