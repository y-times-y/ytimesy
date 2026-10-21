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

/**
 * x11vnc's VNC password (VNC keeps 8 characters): the guest's x11vnc asks
 * every client for it, and only the owner's viewer is given it.
 */
export function desktopVncPassword(vmId: string) {
	return vmEdgeKey("desk-vnc", vmId).slice(0, 8);
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

/** Private preview of one port: forward auth admits only browsers signed in through the app. */
export function previewHostname(vmId: string, port: number) {
	return vmEdgeHostname("pv", vmEdgeKey("preview-host", vmId), port);
}

/** The owner's public link for one port, on its own name so turning sharing off removes only it. Re-sharing restores the same link. */
export function sharedPreviewHostname(vmId: string, port: number) {
	return vmEdgeHostname("share", vmEdgeKey("share-host", vmId), port);
}
