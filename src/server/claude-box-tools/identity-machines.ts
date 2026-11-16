import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	unwrapVmRedaction,
	VM_REDACTION_FAILED,
	vmRedactedCommand,
} from "#/domain/vm-secret-redaction";
import type {
	CommandOutput,
	WorkspaceMachines,
} from "#/server/services/workspace-machines";
import {
	appendFileUpload,
	beginFileUpload,
	commitFileUpload,
	completeFileUpload,
} from "./atomic-file-upload";

/**
 * The chat VM as the Claude runner box reaches it: through a Freestyle
 * identity token that may only run commands on that one VM as one Linux user
 * (claude-box-tool-grant.ts mints it). The token reaches the VM's exec and
 * terminal routes only, so files are written and read with commands too, and
 * the box cannot start, pause, resize or route the VM: those stay on the
 * edge, which started it before the run.
 */
export type GuestExec = (options: {
	command: string;
	timeoutMs?: number;
	/** Base64, at most 1 MiB decoded. */
	stdin?: string;
}) => Promise<{
	stdout?: string | null;
	stderr?: string | null;
	statusCode?: number | null;
}>;

/**
 * The provider answered a command with an error status that means it did
 * not run it (the VM is paused or gone, the grant was revoked, a bad
 * request): the call can be handed to the edge without running twice.
 */
export class BoxMachineRefused extends Error {
	constructor(readonly status: number) {
		super(`The workspace machine refused the command (${status}).`);
		this.name = "BoxMachineRefused";
	}
}

/**
 * A file write in a call whose earlier output had runtime secrets redacted on
 * the VM: the text it would write may hold the placeholder instead of the
 * value (an edit reads the whole file, then writes it back). Nothing was
 * written, so the call can be handed to the edge, which edits the real text.
 */
export class BoxRedactedWrite extends Error {
	constructor() {
		super("This call read redacted text and may not write it back.");
		this.name = "BoxRedactedWrite";
	}
}

/** Freestyle's own exec limit. */
export const GUEST_EXEC_MAX_MS = 300_000;
/** Raw bytes per write command: 1 MiB of stdin at most, decoded. */
const WRITE_CHUNK_BYTES = 768 * 1024;
/** readTextFile's exit status for a missing file. */
const MISSING_EXIT = 3;

function statusOf(error: unknown): number | null {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : null;
}

/** 4xx (other than a request timeout) is answered before the guest runs anything. */
function refusedBeforeRunning(status: number) {
	return status >= 400 && status < 500 && status !== 408;
}

function unsupported(name: string): never {
	throw new Error(`${name} is not available on the Claude runner box.`);
}

export function identityWorkspaceMachines(input: {
	readonly vmId: string;
	readonly exec: GuestExec;
	/** Told after each command the guest ran (for the caller's per-call bookkeeping). */
	readonly onRan?: () => void;
	/**
	 * The turn has runtime secrets: every command's output is redacted on
	 * the VM before it leaves (vm-secret-redaction.ts). `envPath` is for tests.
	 */
	readonly redactOnVm?: {
		readonly envPath?: string;
		/** Told when a command's output had values replaced. */
		readonly onRedacted?: () => void;
		/** Throws (BoxRedactedWrite) to refuse a file write. */
		readonly beforeWrite?: () => void;
	};
}): WorkspaceMachines {
	const redaction = input.redactOnVm;
	const only = (workspaceId: WorkspaceId) => {
		if (workspaceId !== input.vmId)
			throw new Error("This grant reaches only the chat's own machine.");
	};
	const run = async (
		command: string,
		timeoutMs: number,
		stdin?: string,
	): Promise<CommandOutput> => {
		let result: Awaited<ReturnType<GuestExec>>;
		try {
			result = await input.exec({
				command: redaction
					? vmRedactedCommand(command, redaction.envPath)
					: command,
				timeoutMs: Math.min(GUEST_EXEC_MAX_MS, Math.max(1, timeoutMs)),
				...(stdin === undefined ? {} : { stdin }),
			});
		} catch (error) {
			const status = statusOf(error);
			if (status !== null && refusedBeforeRunning(status))
				throw new BoxMachineRefused(status);
			throw error;
		}
		input.onRan?.();
		const output = {
			// Null: killed by its time limit, reported as timeout(1) does.
			exitCode: result.statusCode ?? 124,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
		if (!redaction) return output;
		// No marker: the filter did not run or was cut off (a provider time
		// limit), so nothing it sent is known to be redacted.
		const redacted = unwrapVmRedaction(output.stderr);
		if (!redacted) throw new Error(VM_REDACTION_FAILED);
		if (redacted.replaced > 0) redaction.onRedacted?.();
		return { ...output, stderr: redacted.stderr };
	};
	return {
		async exec(workspaceId, command, timeoutMs = 120_000) {
			only(workspaceId);
			return run(command, timeoutMs);
		},
		async writeTextFile(workspaceId, path, contents) {
			only(workspaceId);
			redaction?.beforeWrite?.();
			const bytes = Buffer.from(contents, "utf8");
			if (bytes.length <= WRITE_CHUNK_BYTES) {
				const written = await run(
					completeFileUpload(path),
					60_000,
					bytes.toString("base64"),
				);
				if (written.exitCode !== 0)
					throw new Error(
						`Could not write ${path}: ${written.stderr.slice(-300)}`.trim(),
					);
				return;
			}
			const prepared = await run(beginFileUpload(path), 60_000);
			if (prepared.exitCode !== 0)
				throw new Error(
					`Could not prepare file upload: ${prepared.stderr.slice(-300)}`,
				);
			const directory = prepared.stdout.trim();
			if (
				!directory.startsWith("/") ||
				!/\/\.ytimesy-upload-[^/\r\n]+$/.test(directory)
			)
				throw new Error(
					"The workspace did not return a file upload directory.",
				);
			try {
				for (
					let start = 0;
					start === 0 || start < bytes.length;
					start += WRITE_CHUNK_BYTES
				) {
					const piece = bytes.subarray(start, start + WRITE_CHUNK_BYTES);
					const written = await run(
						appendFileUpload(directory, start === 0),
						60_000,
						piece.toString("base64"),
					);
					if (written.exitCode !== 0)
						throw new Error(
							`Could not upload ${path}: ${written.stderr.slice(-300)}`.trim(),
						);
				}
				const committed = await run(commitFileUpload(directory), 60_000);
				if (committed.exitCode !== 0)
					throw new Error(
						`Could not finish writing ${path}: ${committed.stderr.slice(-300)}`.trim(),
					);
			} finally {
				// Cleanup must not turn a completed replacement into a failed write.
				await run(`rm -rf -- ${quote(directory)}`, 60_000).catch(() => {});
			}
		},
		async readTextFile(workspaceId, path) {
			only(workspaceId);
			const read = await run(
				`if [ -f ${quote(path)} ]; then cat -- ${quote(path)}; else exit ${MISSING_EXIT}; fi`,
				60_000,
			);
			if (read.exitCode === MISSING_EXIT) return null;
			if (read.exitCode !== 0)
				throw new Error(`Could not read ${path}: ${read.stderr.slice(-300)}`);
			return read.stdout;
		},
		// The edge started the VM before the run; an identity cannot start one.
		ensureRunning: async (workspaceId) => {
			only(workspaceId);
			return WorkspaceId(input.vmId);
		},
		isRunning: async () => true,
		createProofWorkspace: () => unsupported("createProofWorkspace"),
		destroySnapshot: () => unsupported("destroySnapshot"),
		destroy: () => unsupported("destroy"),
		exposeHttp: () => unsupported("exposeHttp"),
		destroyOrphans: () => unsupported("destroyOrphans"),
		snapshotEnvironment: () => unsupported("snapshotEnvironment"),
		provisionSession: () => unsupported("provisionSession"),
	};
}
