import { createFileRoute } from "@tanstack/react-router";
import { goneResponse } from "../../lib/gone";

/** Anything under the old /developers page (docs, OpenAPI, MCP descriptions): removed. */
export const Route = createFileRoute("/developers/$")({
	server: { handlers: { GET: goneResponse, HEAD: goneResponse } },
});
