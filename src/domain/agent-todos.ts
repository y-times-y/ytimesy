export type AgentTodo = {
	readonly text: string;
	readonly status: "pending" | "in_progress" | "completed";
};
