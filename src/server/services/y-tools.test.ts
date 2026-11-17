import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { yTools } from "./y-tools";

const stub = () =>
	tool({
		description: "x",
		inputSchema: z.object({}),
		execute: async () => "",
	});

describe("yTools", () => {
	it("drops every working tool and keeps Y's own", () => {
		const kept = yTools({
			bash: stub(),
			read: stub(),
			edit: stub(),
			write: stub(),
			run_code: stub(),
			web_fetch: stub(),
			agent: stub(),
			agent_send: stub(),
			ask_user: stub(),
			request_project_secret: stub(),
		});
		expect(Object.keys(kept).sort()).toEqual([
			"agent",
			"agent_send",
			"ask_user",
			"request_project_secret",
		]);
	});
});
