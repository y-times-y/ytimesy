export type ApiAgentEvent =
	| { type: "text-delta"; id: string; text: string }
	| { type: "reasoning-delta"; id: string; text: string }
	| { type: "tool-call"; id: string; name: string; input: unknown }
	| { type: "tool-result"; id: string; name: string; output: unknown }
	| {
			type: "finish";
			inputTokens: number | null;
			outputTokens: number | null;
			reason: string;
	  };
