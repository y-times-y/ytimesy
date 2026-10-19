import { authTrustedOrigins } from "../auth/providers";
import { serverConfig } from "../config";

/**
 * Browsers always send Origin on a WebSocket handshake and cookies ride along
 * cross-site, so a missing or foreign Origin is refused before any session
 * work: otherwise any page could drive the signed-in user's terminal or desktop.
 */
export function socketOriginAllowed(
	origin: string | null,
	trustedOrigins: readonly string[],
) {
	return origin !== null && trustedOrigins.includes(origin);
}

export function trustedSocketOrigins() {
	return authTrustedOrigins(serverConfig().APP_URL);
}

export const SOCKET_ORIGIN_REFUSED = "WebSocket origin is not allowed.";
