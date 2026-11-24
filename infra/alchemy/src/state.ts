import * as Cloudflare from "@alchemy.run/cloudflare";
import { localState } from "alchemy/State";

/**
 * Where a stack keeps its state. Real deploys use the Cloudflare state store
 * (a Worker plus a Durable Object in the account, encrypted at rest with a
 * key in Secrets Store), so every machine and chat sees the same state.
 * `YTIMESY_INFRA_STATE=local` is for read-only plans only: it never creates
 * the store and keeps nothing shared (scripts/infra.ts refuses to deploy
 * with it).
 */
export const stackState = () =>
	process.env.YTIMESY_INFRA_STATE === "local" ? localState() : Cloudflare.state();
