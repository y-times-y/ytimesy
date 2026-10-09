import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { z } from "zod";

/** A completed local cutover selects edge execution without editing account credentials. */
async function applyDevelopmentCutover() {
	let contents: string;
	try {
		contents = await readFile(".ytimesy/edge-development.json", "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw error;
	}
	const { origin } = z
		.object({
			origin: z.literal(
				"https://ytimesy-edge-executor-development.example-account.workers.dev",
			),
		})
		.strict()
		.parse(JSON.parse(contents));
	if (
		!new URL(process.env.DATABASE_URL ?? "").username.includes(
			"exampledevprojectref",
		)
	)
		throw new Error(
			"Edge development cutover requires the development database.",
		);
	const realtime = z
		.object({ secret: z.string().min(32) })
		.parse(
			JSON.parse(await readFile(".ytimesy/realtime-development.json", "utf8")),
		);
	Object.assign(process.env, {
		YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
		YTIMESY_MODEL_WORKFLOWS: "true",
		YTIMESY_MODEL_WORKFLOW_URL: origin,
		YTIMESY_ENVIRONMENT_WORKFLOW_URL: origin,
		YTIMESY_BACKGROUND_WORKFLOW_URL: origin,
		YTIMESY_GIT_PROXY_URL: origin,
		YTIMESY_REALTIME_URL: origin,
		YTIMESY_REALTIME_SECRET: realtime.secret,
	});
	console.info(
		"Development execution: Cloudflare DOs and Workflows; no Node job host.",
	);
}

await applyDevelopmentCutover();
const server = await createServer({
	server: { host: "0.0.0.0", port: 3000, strictPort: true },
});
await server.listen();
server.printUrls();
