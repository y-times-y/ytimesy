import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { z } from "zod";

const EDGE_ORIGIN =
	"https://ytimesy-edge-executor-development.hetkp8044.workers.dev";

/** Development executes on Cloudflare DOs and Workflows; there is no Node job host. */
async function configureEdgeExecution() {
	if (
		!new URL(process.env.DATABASE_URL ?? "").username.includes(
			"zqkptvyvoyqqtpihlshw",
		)
	)
		throw new Error(
			"Edge development execution requires the development database.",
		);
	const realtime = z
		.object({ secret: z.string().min(32) })
		.parse(
			JSON.parse(await readFile(".ytimesy/realtime-development.json", "utf8")),
		);
	Object.assign(process.env, {
		// Development-only switches pass only here (isDevelopmentEnvironment).
		YTIMESY_ENVIRONMENT: "development",
		YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
		YTIMESY_ENVIRONMENT_WORKFLOW_URL: EDGE_ORIGIN,
		YTIMESY_BACKGROUND_WORKFLOW_URL: EDGE_ORIGIN,
		YTIMESY_GIT_PROXY_URL: EDGE_ORIGIN,
		YTIMESY_REALTIME_URL: EDGE_ORIGIN,
		YTIMESY_REALTIME_SECRET: realtime.secret,
	});
}

await configureEdgeExecution();
const server = await createServer({
	server: { host: "0.0.0.0", port: 3000, strictPort: true },
});
await server.listen();
server.printUrls();
