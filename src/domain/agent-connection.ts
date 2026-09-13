export type ChatGptAuthMode = "chatgpt";

export type AgentConnection =
	| { readonly status: "disconnected" }
	| {
			readonly status: "awaiting_device_code";
			readonly loginId: string;
			readonly verificationUrl: string;
			readonly userCode: string;
	  }
	| {
			readonly status: "authenticated";
			readonly authMode: ChatGptAuthMode;
			readonly planType: string | null;
			readonly email: string | null;
	  }
	| { readonly status: "expired"; readonly message: string }
	| { readonly status: "failed"; readonly message: string };

export function isAuthenticatedAgent(
	connection: AgentConnection,
): connection is Extract<AgentConnection, { status: "authenticated" }> {
	return connection.status === "authenticated";
}

export function canStartAgentTurn(connection: AgentConnection): boolean {
	return connection.status === "authenticated";
}
