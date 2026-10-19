import { createHash, createHmac } from "node:crypto";
import { vmEdgeHostname } from "#/domain/vm-edge-routes";

/**
 * Per-VM secrets derived from one server-held root, so the web Worker, the
 * edge executor and local scripts agree without storing anything. Rotating
 * BETTER_AUTH_SECRET (or YTIMESY_VM_EDGE_SECRET) moves every hostname and
 * password; the next publish replaces the old routes.
 */
function vmEdgeRoot(env: NodeJS.ProcessEnv = process.env) {
	const explicit = env.YTIMESY_VM_EDGE_SECRET?.trim();
	if (explicit && explicit.length >= 32) return explicit;
	const root = env.BETTER_AUTH_SECRET;
	if (root && root.length >= 32)
		return createHmac("sha256", root).update("ytimesy:vm-edge:v1").digest();
	throw new Error("VM edge secret is not configured.");
}

export function vmEdgeKey(purpose: string, subject: string) {
	return createHmac("sha256", vmEdgeRoot())
		.update(`${purpose}\n${subject}`)
		.digest("hex");
}

export function desktopEdgeHostname(vmId: string) {
	return vmEdgeHostname("desk", vmEdgeKey("desk-host", vmId));
}

/** websockify BasicHTTPAuth source: `user:password`, held server-side and in the guest only. */
export function desktopViewerCredential(vmId: string) {
	return `ytimesy:${vmEdgeKey("desk-auth", vmId).slice(0, 40)}`;
}

export function desktopViewerAuthorization(vmId: string) {
	return `Basic ${Buffer.from(desktopViewerCredential(vmId)).toString("base64")}`;
}

/** What the guest records once websockify runs with this credential (see start-desktop.ts). */
export function desktopViewerCredentialDigest(vmId: string) {
	return createHash("sha256")
		.update(desktopViewerCredential(vmId))
		.digest("hex");
}

export function guestServiceHostname(vmId: string, port: number) {
	return vmEdgeHostname("tools", vmEdgeKey("tools-host", vmId), port);
}
