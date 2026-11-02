import { describe, expect, it } from "vitest";
import {
	authorizationServerMetadataUrls,
	chooseClientRegistration,
	fetchAuthorizationServerMetadata,
	McpSignInUnavailable,
	mcpOAuthAppCredentials,
	mcpSignInStartFailure,
} from "./mcp-oauth-client";

const CIMD = "https://app.example.com/api/mcp/oauth/client-metadata";
const slackApp = {
	MCP_OAUTH_SLACK_CLIENT_ID: "123.456",
	MCP_OAUTH_SLACK_CLIENT_SECRET: "shh",
};

describe("chooseClientRegistration", () => {
	const choose = (
		authorizationServer: string,
		metadata: Parameters<typeof chooseClientRegistration>[0]["metadata"],
		env: Record<string, string> = {},
		clientMetadataUrl = CIMD,
	) =>
		chooseClientRegistration({
			authorizationServer,
			metadata,
			clientMetadataUrl,
			env,
		});

	it("uses dynamic registration when the server offers it", () => {
		expect(
			choose("https://mcp.linear.app", {
				registration_endpoint: "https://mcp.linear.app/register",
				client_id_metadata_document_supported: true,
			}),
		).toEqual({ kind: "dynamic" });
	});

	it("leaves a server without metadata to the SDK's /register default", () => {
		expect(choose("https://auth.example.com", undefined)).toEqual({
			kind: "dynamic",
		});
	});

	it("prefers the owner's registered app, matched on the authorization server", () => {
		expect(choose("https://mcp.slack.com/", {}, slackApp)).toEqual({
			kind: "app",
			service: "SLACK",
			client: { client_id: "123.456", client_secret: "shh" },
		});
	});

	it("uses our metadata document when there is no registration but the server accepts one", () => {
		expect(
			choose("https://auth.example.com", {
				client_id_metadata_document_supported: true,
			}),
		).toEqual({ kind: "metadata-document", client: { client_id: CIMD } });
		// A metadata document id must be HTTPS.
		expect(
			choose(
				"https://auth.example.com",
				{ client_id_metadata_document_supported: true },
				{},
				"http://localhost:3000/api/mcp/oauth/client-metadata",
			),
		).toEqual({ kind: "token", reason: "token" });
	});

	it("falls back to a token: 'setup' for services the owner can register, 'token' otherwise", () => {
		// Slack and GitHub publish no registration endpoint.
		expect(choose("https://mcp.slack.com", {})).toEqual({
			kind: "token",
			reason: "setup",
		});
		expect(choose("https://github.com/login/oauth", {})).toEqual({
			kind: "token",
			reason: "setup",
		});
		// Half-configured apps do not count.
		expect(
			choose("https://mcp.slack.com", {}, { MCP_OAUTH_SLACK_CLIENT_ID: "x" }),
		).toEqual({ kind: "token", reason: "setup" });
		// Render: public client allowlist, nothing the owner can register.
		expect(choose("https://api.render.com", {})).toEqual({
			kind: "token",
			reason: "token",
		});
	});
});

it("reads app credentials from MCP_OAUTH_<SERVICE>_CLIENT_ID/_SECRET", () => {
	expect(mcpOAuthAppCredentials("SLACK", slackApp)).toEqual({
		client_id: "123.456",
		client_secret: "shh",
	});
	expect(
		mcpOAuthAppCredentials("GITHUB", {
			MCP_OAUTH_GITHUB_CLIENT_ID: " ",
			MCP_OAUTH_GITHUB_CLIENT_SECRET: "s",
		}),
	).toBeNull();
});

it("discovers metadata in the MCP spec's order, including OIDC appended after a path", async () => {
	expect(authorizationServerMetadataUrls("https://mcp.slack.com")).toEqual([
		"https://mcp.slack.com/.well-known/oauth-authorization-server",
		"https://mcp.slack.com/.well-known/openid-configuration",
	]);
	const asked: string[] = [];
	// PagerDuty serves only the appended OIDC form.
	const metadata = await fetchAuthorizationServerMetadata(
		"https://app.pagerduty.com/global/oauth/anonymous",
		(async (url: string) => {
			asked.push(url);
			return url.endsWith("/anonymous/.well-known/openid-configuration")
				? Response.json({
						registration_endpoint:
							"https://app.pagerduty.com/global/oauth-registration",
					})
				: new Response("no", { status: 404 });
		}) as typeof fetch,
	);
	expect(asked).toHaveLength(3);
	expect(metadata).toEqual({
		registration_endpoint:
			"https://app.pagerduty.com/global/oauth-registration",
		client_id_metadata_document_supported: false,
	});
});

describe("mcpSignInStartFailure", () => {
	it("asks for a token instead of showing the SDK's registration error", () => {
		expect(
			mcpSignInStartFailure(
				new Error(
					"Incompatible auth server: does not support dynamic client registration",
				),
			),
		).toEqual({ url: null, needs: "token", reason: "token" });
	});

	it("keeps the reason from our own check", () => {
		expect(mcpSignInStartFailure(new McpSignInUnavailable("setup"))).toEqual({
			url: null,
			needs: "token",
			reason: "setup",
		});
	});

	it("turns anything else into a short retry, never the raw text", () => {
		const result = mcpSignInStartFailure(
			new Error("HTTP 500 trying to load OAuth metadata from https://x"),
		);
		expect(result).toEqual({ url: null, failed: true });
		expect(JSON.stringify(result)).not.toContain("HTTP 500");
	});
});
