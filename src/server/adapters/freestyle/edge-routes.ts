import type { Freestyle } from "freestyle";
import {
	type VmEdgeRoute,
	type VmEdgeRouteKind,
	vmEdgeRouteIsSuperseded,
	vmEdgeRouteKind,
} from "#/domain/vm-edge-routes";

/** Our TLS routes on one VM (rules whose names this app owns). */
export async function listVmEdgeRoutes(
	freestyle: Freestyle,
	vmId: string,
): Promise<VmEdgeRoute[]> {
	const { rules } = await freestyle.tls.rules.list({ vmId, limit: 100 });
	return rules.flatMap((rule) =>
		rule.source.public === true &&
		rule.destination.vmId !== undefined &&
		rule.destination.port !== undefined &&
		vmEdgeRouteKind(rule.domain)
			? [
					{
						ruleId: rule.id,
						domain: rule.domain,
						port: rule.destination.port,
						forwardAuthId: rule.forwardAuth?.id ?? null,
					},
				]
			: [],
	);
}

/**
 * Publishes `hostname` → VM port, idempotently, and deletes routes it
 * supersedes (an older desktop or tool-service name, or a preview's previous
 * name for the same port). A route whose forward-auth setting changed is
 * updated in place, keeping its id.
 */
export async function publishVmEdgeRoute(
	freestyle: Freestyle,
	vmId: string,
	route: { hostname: string; port: number; forwardAuthId?: string },
): Promise<{ origin: string; ruleId: string }> {
	const wanted = { domain: route.hostname, port: route.port };
	const existing = await listVmEdgeRoutes(freestyle, vmId);
	for (const stale of existing.filter((current) =>
		vmEdgeRouteIsSuperseded(current, wanted),
	))
		await deleteRule(freestyle, stale.ruleId);
	const rule = {
		action: "allow" as const,
		domain: route.hostname,
		source: { public: true as const },
		destination: { vmId, port: route.port },
		...(route.forwardAuthId
			? { forwardAuth: { id: route.forwardAuthId } }
			: {}),
	};
	const same = existing.find(
		(current) =>
			current.domain === route.hostname && current.port === route.port,
	);
	const ruleId = !same
		? (await freestyle.tls.rules.create(rule)).id
		: same.forwardAuthId === (route.forwardAuthId ?? null)
			? same.ruleId
			: (await freestyle.tls.rules.update(same.ruleId, rule)).id;
	return { origin: `https://${route.hostname}`, ruleId };
}

/** Deletes our routes of these kinds (optionally one port's) on a VM; returns how many went. */
export async function withdrawVmEdgeRoutes(
	freestyle: Freestyle,
	vmId: string,
	kinds: readonly VmEdgeRouteKind[],
	port?: number,
) {
	const doomed = (await listVmEdgeRoutes(freestyle, vmId)).filter((route) => {
		const kind = vmEdgeRouteKind(route.domain);
		return (
			kind !== null &&
			kinds.includes(kind) &&
			(port === undefined || route.port === port)
		);
	});
	for (const route of doomed) await deleteRule(freestyle, route.ruleId);
	return doomed.length;
}

async function deleteRule(freestyle: Freestyle, ruleId: string) {
	await freestyle.tls.rules.delete(ruleId).catch((error: unknown) => {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 404
		)
			return;
		throw error;
	});
}
