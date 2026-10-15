import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { captureSessionCheckpoint } from "./session-checkpoint";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	project: vi.fn(),
	previous: vi.fn(),
	capture: vi.fn(),
	download: vi.fn(),
	upload: vi.fn(),
	save: vi.fn(),
	remove: vi.fn(),
	confirm: vi.fn(),
	recordFailure: vi.fn(),
	clearFailure: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
}));
vi.mock("../adapters/projects", () => ({ projectForOwner: mocks.project }));
vi.mock("../adapters/checkpoints/guest", () => ({
	exportGuestCheckpoint: mocks.capture,
	restoreGuestCheckpoint: vi.fn(),
}));
vi.mock("../adapters/checkpoints/records", () => ({
	checkpointForSession: mocks.previous,
	saveSessionCheckpoint: mocks.save,
	confirmUnchangedCheckpoint: mocks.confirm,
	recordCheckpointFailure: mocks.recordFailure,
	clearCheckpointFailure: mocks.clearFailure,
}));
vi.mock("../adapters/checkpoints/storage", () => ({
	downloadCheckpoint: mocks.download,
	uploadCheckpoint: mocks.upload,
	removeCheckpoint: mocks.remove,
}));

const unsupported = async () => {
	throw new Error("Unexpected machine operation");
};
const machines: WorkspaceMachines = {
	createProofWorkspace: unsupported,
	snapshotAuthenticatedWorkspace: unsupported,
	destroySnapshot: unsupported,
	exec: unsupported,
	writeTextFile: unsupported,
	readTextFile: unsupported,
	destroy: unsupported,
	ensureRunning: vi.fn(async (id) => id),
	isRunning: unsupported,
	exposeHttp: unsupported,
	destroyOrphans: unsupported,
	snapshotEnvironment: unsupported,
	provisionSession: unsupported,
};
const session = {
	id: "chat",
	userId: "owner",
	projectId: "project",
	providerRef: "vm",
	turnStatus: "completed",
	taskPlacement: "fresh",
	items: [],
};
const fingerprint = createHash("sha256")
	.update("checkpoint-v2:")
	.update("[]")
	.digest("hex");
beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue(session);
	mocks.project.mockResolvedValue({ fullName: "owner/repo" });
	mocks.previous.mockResolvedValue({
		object_path: "old",
		executor_id: "vm",
		runner_id: null,
		turn_fingerprint: fingerprint,
		workspace_sha256: createHash("sha256").update("before").digest("hex"),
	});
	mocks.download.mockResolvedValue(
		JSON.stringify({ workspace: "before", native: null }),
	);
	mocks.capture.mockResolvedValue("after");
	mocks.upload.mockResolvedValue("new");
	mocks.recordFailure.mockResolvedValue(undefined);
	mocks.clearFailure.mockResolvedValue(undefined);
});

it("captures terminal edits even when the transcript fingerprint is unchanged", async () => {
	await captureSessionCheckpoint(machines, "owner", "chat");
	expect(machines.ensureRunning).toHaveBeenCalledWith(WorkspaceId("vm"));
	expect(mocks.capture).toHaveBeenCalled();
	expect(mocks.upload).toHaveBeenCalledWith(
		"owner",
		"chat",
		expect.any(String),
		JSON.stringify({ workspace: "after", native: null }),
	);
	expect(mocks.save).toHaveBeenCalledWith(
		expect.objectContaining({
			workspaceSha256: createHash("sha256").update("after").digest("hex"),
		}),
	);
	expect(mocks.remove).toHaveBeenCalledWith("old");
	// The previous object is never downloaded just to compare workspaces.
	expect(mocks.download).not.toHaveBeenCalled();
});

it("deduplicates storage only after comparing a fresh capture", async () => {
	mocks.capture.mockResolvedValue("before");
	await captureSessionCheckpoint(machines, "owner", "chat");
	expect(mocks.capture).toHaveBeenCalled();
	expect(mocks.confirm).toHaveBeenCalledWith("owner", "chat", fingerprint);
	expect(mocks.upload).not.toHaveBeenCalled();
	expect(mocks.download).not.toHaveBeenCalled();
});

it("downloads the previous checkpoint only to retain legacy runner state", async () => {
	mocks.previous.mockResolvedValue({
		object_path: "old",
		executor_id: "vm",
		runner_id: "legacy-runner",
		turn_fingerprint: fingerprint,
		workspace_sha256: null,
	});
	mocks.download.mockResolvedValue(
		JSON.stringify({ workspace: "before", native: { thread: "t" } }),
	);
	await captureSessionCheckpoint(machines, "owner", "chat");
	expect(mocks.download).toHaveBeenCalledWith("owner", "chat", "old");
	expect(mocks.upload).toHaveBeenCalledWith(
		"owner",
		"chat",
		expect.any(String),
		JSON.stringify({ workspace: "after", native: { thread: "t" } }),
	);
});

it("does not confirm or replace a checkpoint when capture fails", async () => {
	mocks.capture.mockRejectedValue(new Error("Capture failed"));
	await expect(
		captureSessionCheckpoint(machines, "owner", "chat"),
	).rejects.toThrow("Capture failed");
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(mocks.remove).not.toHaveBeenCalled();
});

it("refuses to save if the workspace identity changed during capture", async () => {
	mocks.session
		.mockResolvedValueOnce(session)
		.mockResolvedValueOnce({ ...session, providerRef: "replacement" });
	await expect(
		captureSessionCheckpoint(machines, "owner", "chat"),
	).rejects.toThrow("advanced");
	expect(mocks.upload).not.toHaveBeenCalled();
	expect(mocks.recordFailure).toHaveBeenCalledWith("chat", "advanced");
});

it("records the failing stage so the backstop backs off instead of waking the VM every minute", async () => {
	mocks.capture.mockRejectedValue(new Error("Checkpoint exceeds safety limit"));
	await expect(
		captureSessionCheckpoint(machines, "owner", "chat"),
	).rejects.toThrow("safety limit");
	expect(mocks.recordFailure).toHaveBeenCalledWith("chat", "export");
	expect(mocks.clearFailure).not.toHaveBeenCalled();
});

it("records an upload failure at its stage", async () => {
	mocks.upload.mockRejectedValue(new Error("storage unavailable"));
	await expect(
		captureSessionCheckpoint(machines, "owner", "chat"),
	).rejects.toThrow("storage unavailable");
	expect(mocks.recordFailure).toHaveBeenCalledWith("chat", "upload");
});

it("clears a recorded failure once a capture succeeds", async () => {
	await captureSessionCheckpoint(machines, "owner", "chat");
	expect(mocks.clearFailure).toHaveBeenCalledWith("chat");
	expect(mocks.recordFailure).not.toHaveBeenCalled();
});

it("does not wake the machine when the project is gone", async () => {
	mocks.project.mockResolvedValue(null);
	await captureSessionCheckpoint(machines, "owner", "chat");
	expect(machines.ensureRunning).not.toHaveBeenCalled();
});
