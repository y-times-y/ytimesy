import { PINNED_CLAUDE_AGENT_SDK_VERSION } from "../src/domain/guest-cli-pin";

/** Private clean image, boot-verified as builder and reader; contains no project data. */
export const PRODUCTION_TOOLS_IMAGE = {
	snapshotId: "sh-12db89b56a6044e895fddd638ed4f946",
	claudeAgentSdkVersion: "0.3.321",
} as const;

/** A new SDK pin cannot ship while production still boots an older SDK image. */
export function productionToolsSnapshotId(
	image: {
		readonly snapshotId: string;
		readonly claudeAgentSdkVersion: string;
	} = PRODUCTION_TOOLS_IMAGE,
) {
	if (image.claudeAgentSdkVersion !== PINNED_CLAUDE_AGENT_SDK_VERSION)
		throw new Error(
			"Rebuild and boot-verify the production tools image for the pinned Claude SDK before deploying.",
		);
	return image.snapshotId;
}
