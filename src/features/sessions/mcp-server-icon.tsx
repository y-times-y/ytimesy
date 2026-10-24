import { QueryClientContext } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { useContext } from "react";
import { mcpServerLabel } from "#/domain/connector-name";
import type { PublicMcpServer } from "#/server/adapters/mcp-servers";
import { brandMark } from "./brand-logo";

/**
 * The server's URL from Settings' list, when this page already loaded it;
 * never fetched here, so a transcript makes no extra request.
 */
function useKnownServerUrl(server: string) {
	const client = useContext(QueryClientContext);
	return client
		?.getQueryData<PublicMcpServer[]>(["mcp-servers"])
		?.find((entry) => entry.name === server)?.url;
}

/**
 * An MCP call's icon: the mark Settings shows for that server (a bundled
 * brand logo, else its initial on a tile), at the timeline's 14px size.
 * Without a server name, a plug. Never loads a remote image.
 */
export function McpServerIcon({ server }: { server?: string }) {
	const url = useKnownServerUrl(server ?? "");
	if (!server) return <Plug size={14} strokeWidth={1.5} aria-hidden="true" />;
	const mark = brandMark(server, mcpServerLabel(server), url);
	if (mark.kind === "logo")
		return (
			<span
				className="mcp-server-icon"
				data-brand={mark.brand}
				aria-hidden="true"
			>
				<svg viewBox="0 0 24 24" fill={mark.fill}>
					<title>{mcpServerLabel(server)}</title>
					<path d={mark.path} />
				</svg>
			</span>
		);
	return (
		<span
			className="mcp-server-icon"
			data-letter="true"
			data-brand={mark.brand}
			style={mark.background ? { background: mark.background } : undefined}
			aria-hidden="true"
		>
			{mark.label}
		</span>
	);
}
