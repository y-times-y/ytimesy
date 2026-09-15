import { workspaceLooksGone } from "./failure-message";

export function loginStatusLooksLikeGoneWorkspace(status: {
	readonly stage: string;
	readonly message?: string;
}): boolean {
	return status.stage === "failed" && workspaceLooksGone(status.message ?? "");
}

export function shouldStartDeviceCodeAfterSnapshotResume(status: {
	readonly stage: string;
	readonly message?: string;
}): boolean {
	return status.stage === "failed" && !workspaceLooksGone(status.message ?? "");
}
