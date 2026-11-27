import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../projects/api";

/** What a GitHub number is. GitHub numbers issues and pull requests together. */
export type ReferenceKind = "issue" | "pull-request";

/** The ids the GitHub integration needs to read one repository. */
export type ReferenceRepository = {
	readonly installationId: number;
	readonly repositoryId: number;
};

/** A number's type never changes, so one read serves a day (and a reload, below). */
export const REFERENCE_KIND_FRESH_MS = 24 * 60 * 60 * 1000;

const STORAGE_PREFIX = "ytimesy:reference-kind:";

function storedKind(key: string): ReferenceKind | undefined {
	try {
		const value = globalThis.sessionStorage?.getItem(STORAGE_PREFIX + key);
		return value === "issue" || value === "pull-request" ? value : undefined;
	} catch {
		return undefined;
	}
}

function storeKind(key: string, kind: ReferenceKind) {
	try {
		globalThis.sessionStorage?.setItem(STORAGE_PREFIX + key, kind);
	} catch {
		// A full or blocked storage only costs one more read.
	}
}

/**
 * The type of "owner/repo#12" in a repository the workspace can read, from
 * one cached GitHub read per number (never polled, never retried: a refused
 * or rate-limited read leaves the chip neutral). Undefined until known.
 */
/** The one query the chip and a click on it share, so a number is read once. */
export function referenceKindQuery(
	repository: ReferenceRepository,
	number: number,
) {
	const lookup = `${repository.repositoryId}#${number}`;
	return {
		queryKey: ["github", "reference-kind", repository.repositoryId, number],
		queryFn: async (): Promise<ReferenceKind> => {
			const { kind } = await requestJson<{ kind: ReferenceKind }>(
				`/api/github/issue?${new URLSearchParams({
					installationId: String(repository.installationId),
					repositoryId: String(repository.repositoryId),
					number: String(number),
					kind: "1",
				})}`,
			);
			storeKind(lookup, kind);
			return kind;
		},
		initialData: storedKind(lookup),
		staleTime: REFERENCE_KIND_FRESH_MS,
		gcTime: REFERENCE_KIND_FRESH_MS,
		retry: false,
	};
}

export function useReferenceKind(
	key: string,
	repository: ReferenceRepository,
	number: number,
	enabled = true,
): ReferenceKind | undefined {
	const { data } = useQuery({
		...referenceKindQuery(repository, number),
		enabled,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		meta: { reference: key },
	});
	return data;
}
