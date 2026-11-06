import { createFileRoute } from "@tanstack/react-router";
import { goneResponse } from "../../lib/gone";

/** The old /developers page: removed, answered 410 so search engines drop it. */
export const Route = createFileRoute("/developers/")({
	server: { handlers: { GET: goneResponse, HEAD: goneResponse } },
});
