import { RIGKIT_NODE_GAP } from "#/domain/workspace-preparation";

export const RIGKIT_PACKAGES = {
	sdk: "0.3.0",
	providerFreestyle: "0.3.0",
} as const;

export const RIGKIT_INTEGRATION_STATUS = {
	verifiedDocs: [
		"https://www.rigkit.dev/docs/bash",
		"https://www.npmjs.com/package/@rigkit/provider-freestyle",
	],
	apiKeyAuth: "freestyle.provider({ apiKey }) or FREESTYLE_API_KEY",
	inAppEmbedding: RIGKIT_NODE_GAP,
} as const;
