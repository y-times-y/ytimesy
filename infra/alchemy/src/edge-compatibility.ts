/**
 * From compatibility date 2026-10-01 a pending timer, waitUntil promise or RPC
 * pins an idle Durable Object in memory for up to 15 minutes, and Cloudflare
 * bills duration for all of it. This flag restores eviction once the handler
 * has returned. Best-effort tails (notes, history stores) each have a backstop.
 */
export const EVICTION_FLAG = "durable_object_io_tasks_do_not_prevent_eviction";

export const EDGE_COMPATIBILITY = {
	date: "2026-10-08",
	flags: ["nodejs_compat", EVICTION_FLAG],
};
