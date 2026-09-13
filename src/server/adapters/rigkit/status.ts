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
	inAppEmbedding:
		"Not used yet. @rigkit/sdk 0.3.0 targets a Bun project daemon and pulls @effect/platform-bun; workspace VMs are created with the Freestyle SDK until Rigkit can run as a Node worker.",
} as const;
