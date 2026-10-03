import { readFileSync } from "node:fs";
import { z } from "zod";

const schema = z.object({ url: z.string().url(), secret: z.string().min(32) });
let cached: z.infer<typeof schema> | undefined;
export function realtimeDevelopmentConfiguration() {
	if (process.env.NODE_ENV === "production" || process.env.VITEST) return null;
	if (cached) return cached;
	try {
		cached = schema.parse(
			JSON.parse(readFileSync(".ytimesy/realtime-development.json", "utf8")),
		);
		return cached;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("Private development realtime configuration is invalid.");
	}
}
