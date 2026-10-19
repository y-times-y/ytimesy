// Fixed development endpoints shared by the scripts. Production values live
// in scripts/deploy-production.ts and the wrangler configs' production envs.

/** The Cloudflare account every Worker deploys to (wrangler.*.jsonc account_id). */
export const CLOUDFLARE_ACCOUNT_ID = "00000000000000000000000000000000";

/** The account's workers.dev subdomain, where development Workers are reachable. */
export const WORKERS_DEV_SUBDOMAIN = "example-account.workers.dev";

/** The development edge executor's origin (model turns, jobs, Git proxy, realtime). */
export const DEVELOPMENT_EDGE_ORIGIN = `https://ytimesy-edge-executor-development.${WORKERS_DEV_SUBDOMAIN}`;
