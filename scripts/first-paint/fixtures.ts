// Chats the first-paint check opens: plain rows in agent_session, as a
// finished chat stores them. No machine, no model.
const reply = [
	"Here is the fix, with the parts that matter:",
	"",
	"1. **Read** the config once.",
	"2. **Cache** it per isolate.",
	"3. Return `null` when it is missing.",
	"",
	"```ts",
	"export function readConfig(raw: string | null): Config | null {",
	"\tif (!raw) return null;",
	"\ttry {",
	"\t\treturn JSON.parse(raw) as Config;",
	"\t} catch {",
	"\t\treturn null;",
	"\t}",
	"}",
	"```",
	"",
	"Run it:",
	"",
	"```bash",
	"pnpm vitest run src/domain/config.test.ts",
	"```",
	"",
	"| File | Change |",
	"| --- | --- |",
	"| `config.ts` | read once |",
	"| `config.test.ts` | new cases |",
	"",
	"> Nothing else changes.",
].join("\n");

const turn = (n: number) => [
	{
		kind: "userMessage",
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		text: `Turn ${n}: the config is read on every request. Can you fix that and show me the code?`,
	},
	{
		kind: "reasoning",
		id: `reasoning-${n}`,
		summaries: ["Looking at how the config is loaded per request."],
		durationSeconds: 4,
	},
	{
		kind: "agentMessage",
		id: `agent-${n}`,
		text: reply,
		phase: "final_answer",
	},
];

export const FIRST_PAINT_CHATS = [
	{ key: "rich", title: "Config read once", items: [1, 2, 3, 4].flatMap(turn) },
	{ key: "short", title: "Short chat", items: turn(1) },
	{ key: "empty", title: "New session", items: [] },
] as const;
