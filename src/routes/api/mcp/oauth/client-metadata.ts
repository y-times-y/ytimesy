import { createFileRoute } from "@tanstack/react-router";
import { serverConfig } from "../../../../server/config";
import { mcpClientMetadataDocument } from "../../../../server/services/mcp-oauth";

/**
 * Our OAuth Client ID Metadata Document. Authorization servers that support
 * them (and lack dynamic registration) fetch this URL, which is our client id.
 */
export const Route = createFileRoute("/api/mcp/oauth/client-metadata")({
	server: {
		handlers: {
			GET: () =>
				Response.json(mcpClientMetadataDocument(serverConfig().APP_URL), {
					headers: { "Cache-Control": "public, max-age=3600" },
				}),
		},
	},
});
