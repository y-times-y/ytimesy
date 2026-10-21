/**
 * Names for the public TLS routes Freestyle's edge serves for a workspace VM.
 * Every route lands on `<kind>-<label>[-<port>].style.dev`, where the label is
 * a server-held HMAC of the VM id (vm-edge-keys.ts), so a VM id alone does not
 * reveal its routes.
 */
export const VM_EDGE_ROUTE_KINDS = ["desk", "tools", "pv", "share"] as const;
export type VmEdgeRouteKind = (typeof VM_EDGE_ROUTE_KINDS)[number];

const EDGE_SUFFIX = ".style.dev";
const LABEL_LENGTH = 24;

export type VmEdgeRoute = {
	readonly ruleId: string;
	readonly domain: string;
	readonly port: number;
	readonly forwardAuthId: string | null;
};

export function vmEdgeHostname(
	kind: VmEdgeRouteKind,
	label: string,
	port?: number,
) {
	if (!/^[a-f0-9]+$/.test(label) || label.length < LABEL_LENGTH)
		throw new Error("VM edge label must be at least 24 hex characters.");
	return `ytimesy-${kind}-${label.slice(0, LABEL_LENGTH)}${port === undefined ? "" : `-${port}`}${EDGE_SUFFIX}`;
}

/** The kind of one of our routes, including the pre-HMAC legacy names; null for anything else. */
export function vmEdgeRouteKind(domain: string): VmEdgeRouteKind | null {
	if (!domain.endsWith(EDGE_SUFFIX)) return null;
	const match = /^ytimesy-([a-z]+)-/.exec(domain);
	const kind = match?.[1];
	return VM_EDGE_ROUTE_KINDS.find((known) => known === kind) ?? null;
}

/**
 * Whether publishing `wanted` makes `existing` obsolete. A VM has one desktop
 * and one tool-service route (the service's port changes when it restarts), so
 * any other route of those kinds is stale; previews and shares are per port.
 */
export function vmEdgeRouteIsSuperseded(
	existing: Pick<VmEdgeRoute, "domain" | "port">,
	wanted: Pick<VmEdgeRoute, "domain" | "port">,
) {
	const kind = vmEdgeRouteKind(wanted.domain);
	if (!kind || vmEdgeRouteKind(existing.domain) !== kind) return false;
	if (existing.domain === wanted.domain && existing.port === wanted.port)
		return false;
	if (kind === "desk" || kind === "tools") return true;
	return existing.port === wanted.port;
}
