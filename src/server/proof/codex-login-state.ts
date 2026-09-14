import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

export const PROOF_VM_STATE_PATH = ".ytimesy/proof-state.json";
export const AUTH_SNAPSHOT_STATE_PATH = ".ytimesy/codex-auth-snapshot.json";

export type ProofVmState = {
	readonly workspaceId: string;
	readonly slug: string;
	readonly startedAt: string;
	readonly bootedFromSnapshotId: string | null;
};

export type ProofAuthSnapshotState = {
	readonly snapshotId: string;
	readonly sourceWorkspaceId: string;
	readonly createdAt: string;
	readonly public: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseProofVmState(raw: string): ProofVmState {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error("Proof VM state was not an object");
	}
	const workspaceId = readString(parsed.workspaceId);
	const slug = readString(parsed.slug);
	const startedAt = readString(parsed.startedAt);
	if (!workspaceId || !slug || !startedAt) {
		throw new Error(
			"Proof VM state is missing workspaceId, slug, or startedAt",
		);
	}
	const bootedFromSnapshotId =
		parsed.bootedFromSnapshotId === null ||
		parsed.bootedFromSnapshotId === undefined
			? null
			: readString(parsed.bootedFromSnapshotId);
	if (
		parsed.bootedFromSnapshotId !== undefined &&
		bootedFromSnapshotId === undefined
	) {
		throw new Error("Proof VM state has an empty bootedFromSnapshotId");
	}
	return {
		workspaceId,
		slug,
		startedAt,
		bootedFromSnapshotId: bootedFromSnapshotId ?? null,
	};
}

export function parseAuthSnapshotState(raw: string): ProofAuthSnapshotState {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error("Auth snapshot state was not an object");
	}
	if (parsed.public === true) {
		throw new Error(
			"Refusing a public Codex auth snapshot; credentials cannot live in a shared image",
		);
	}
	const snapshotId = readString(parsed.snapshotId);
	const sourceWorkspaceId = readString(parsed.sourceWorkspaceId);
	const createdAt = readString(parsed.createdAt);
	if (!snapshotId || !sourceWorkspaceId || !createdAt) {
		throw new Error(
			"Auth snapshot state is missing snapshotId, sourceWorkspaceId, or createdAt",
		);
	}
	return {
		snapshotId,
		sourceWorkspaceId,
		createdAt,
		public: false,
	};
}

async function readOptionalFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
			return null;
		}
		throw cause;
	}
}

export async function readProofVmState(): Promise<ProofVmState | null> {
	const raw = await readOptionalFile(PROOF_VM_STATE_PATH);
	return raw ? parseProofVmState(raw) : null;
}

export async function readAuthSnapshotState(): Promise<ProofAuthSnapshotState | null> {
	const raw = await readOptionalFile(AUTH_SNAPSHOT_STATE_PATH);
	return raw ? parseAuthSnapshotState(raw) : null;
}

export async function writeProofVmState(state: ProofVmState): Promise<void> {
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(PROOF_VM_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export async function writeAuthSnapshotState(
	state: ProofAuthSnapshotState,
): Promise<void> {
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(
		AUTH_SNAPSHOT_STATE_PATH,
		`${JSON.stringify(state, null, 2)}\n`,
	);
}

export async function deleteProofVmState(): Promise<void> {
	await unlink(PROOF_VM_STATE_PATH).catch(() => undefined);
}

export async function deleteAuthSnapshotState(): Promise<void> {
	await unlink(AUTH_SNAPSHOT_STATE_PATH).catch(() => undefined);
}
