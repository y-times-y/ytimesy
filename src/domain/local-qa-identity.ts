export type LocalQaUserCandidate = {
	readonly id: string;
	readonly github: boolean;
	readonly hasProject: boolean;
	readonly lastSessionAt: string | null;
};

export function hostnameFromHostHeader(host: string | undefined) {
	if (!host) return "";
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end === -1 ? host.toLowerCase() : host.slice(1, end).toLowerCase();
	}
	return host.split(":")[0]?.toLowerCase() ?? "";
}

export function hostIsLoopback(host: string | undefined) {
	const hostname = hostnameFromHostHeader(host);
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
	);
}

export function localQaIdentityAllowed(input: {
	readonly nodeEnv?: string;
	readonly host?: string;
}) {
	return input.nodeEnv === "development" && hostIsLoopback(input.host);
}

export function authGetSessionPath(pathname: string) {
	return pathname.replace(/\/+$/, "").endsWith("/get-session");
}

export function preferLocalQaUser(
	candidates: readonly LocalQaUserCandidate[],
): LocalQaUserCandidate | null {
	if (candidates.length === 0) return null;
	return [...candidates].sort((left, right) => {
		const rank = localQaUserRank(right) - localQaUserRank(left);
		if (rank !== 0) return rank;
		return (right.lastSessionAt ?? "").localeCompare(left.lastSessionAt ?? "");
	})[0];
}

function localQaUserRank(candidate: LocalQaUserCandidate) {
	return (
		(candidate.github ? 4 : 0) +
		(candidate.hasProject ? 2 : 0) +
		(candidate.lastSessionAt ? 1 : 0)
	);
}
