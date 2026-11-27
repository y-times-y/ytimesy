/**
 * How an agent gets a pull request, in the few lines every route sends. The
 * chat's machine holds no secrets (docs/architecture.md), so `gh` and a
 * GH_TOKEN can never work there; the edge holds GitHub's credentials. There
 * is deliberately no pull request tool (each tool definition costs tokens on
 * every turn): the end-of-turn handoff pushes and opens or updates the draft
 * pull request, and the pull request chip and the transcript carry its link.
 * pull-request-instructions.test.ts fails on text that teaches `gh` or asking
 * for a token.
 */
export const PULL_REQUEST_INSTRUCTIONS =
	'GitHub is already connected: never use `gh`, ask for a GH_TOKEN or ask the user to open the pull request. Push your branch; when your turn ends ytimesy opens or updates its draft pull request, so say "Pushed branch <name>; the pull request is opened automatically." and name a number or link only when ytimesy shows one. For the default branch, use request_push_approval.';
