/** A journaled tool response, as agent_task_command_receipt stores it. */
export type AgentTaskToolResponse = {
	readonly id: string;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
	readonly requestFingerprint?: string;
};
