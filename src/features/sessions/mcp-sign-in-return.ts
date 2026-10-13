import type { SettingsSection } from "#/domain/workspace-settings";

/**
 * Where to bring the user back after an MCP provider's sign-in page. Kept in
 * sessionStorage: it survives the round trip through the provider in this tab
 * and nothing about it needs to reach the server.
 */
export type McpSignInReturn = {
	readonly path: string;
	readonly section: SettingsSection;
	readonly serverId: string;
};

const key = "ytimesy:mcp-sign-in-return";

export function rememberMcpSignInReturn(
	section: SettingsSection,
	serverId: string,
) {
	const value: McpSignInReturn = {
		path: `${window.location.pathname}${window.location.search}`,
		section,
		serverId,
	};
	window.sessionStorage.setItem(key, JSON.stringify(value));
}

export function takeMcpSignInReturn(): McpSignInReturn | null {
	const raw = window.sessionStorage.getItem(key);
	window.sessionStorage.removeItem(key);
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as McpSignInReturn;
		// Same-origin paths only.
		return value.path.startsWith("/") && !value.path.startsWith("//")
			? value
			: null;
	} catch {
		return null;
	}
}

export type McpSignInResult = "ok" | "cancelled" | "failed";

export function mcpSignInResult(search: string): McpSignInResult | null {
	const value = new URLSearchParams(search).get("mcpSignIn");
	return value === "ok" || value === "cancelled" || value === "failed"
		? value
		: null;
}
