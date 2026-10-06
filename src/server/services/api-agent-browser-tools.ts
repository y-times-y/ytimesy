import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { isPublicModelAddress } from "#/server/adapters/model-endpoint";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import {
	BROWSER_INSPECTION_SOURCE,
	browserAssertion,
	browserInspection,
} from "./browser-inspection";
import { runGuestCapability } from "./guest-node-capability";
import { ensureDesktopProcesses } from "./workspace-desktop";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function safeBrowserUrl(value: string): Promise<string> {
	const url = new URL(value);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password
	)
		throw new Error("Browser pages must use HTTP(S) without URL credentials.");
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host === "127.0.0.1" || host === "::1")
		return url.href;
	const addresses = await lookup(host, { all: true, verbatim: true }).catch(
		() => [],
	);
	if (
		!addresses.length ||
		addresses.some(({ address }) => !isPublicModelAddress(address))
	)
		throw new Error(
			"Browser pages must resolve to public addresses or localhost.",
		);
	return url.href;
}

export function apiAgentBrowserTools(
	input: AgentToolWorkspaceInput & {
		readOnly: boolean;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
	},
): ToolSet {
	const { signal, once } = input;
	async function desktop() {
		signal.throwIfAborted();
		const workspace = await resolveToolWorkspace(input);
		const { machines, vm } = workspace;
		const result = await ensureDesktopProcesses(machines, vm);
		if (result.exitCode) throw new Error("The shared desktop could not start.");
		return workspace;
	}
	const tools: ToolSet = {
		browser_inspect: tool({
			description:
				"Inspect an already-open shared browser page: rendered text and control structure (without input values), selector/text/visibility assertions, and console/network observations during a bounded interval. This is not historical logging. Do not inspect private account pages or expose secrets unnecessarily.",
			inputSchema: z.object({
				url: z.url().max(2048),
				assertions: z.array(browserAssertion).max(20).default([]),
				observeMilliseconds: z.number().int().min(0).max(10000).default(0),
			}),
			execute: async (args) => {
				const url = await safeBrowserUrl(args.url);
				return runGuestCapability(
					await desktop(),
					"browser",
					BROWSER_INSPECTION_SOURCE,
					{ ...args, url },
					browserInspection,
					signal,
				);
			},
		}),
		browser_open: tool({
			description:
				"Open an HTTP or HTTPS URL in the task's shared Linux desktop browser. The user can watch in the Desktop tab.",
			inputSchema: z.object({ url: z.url().max(2048) }),
			execute: ({ url }, options) =>
				once(options.toolCallId, async () => {
					const target = await safeBrowserUrl(url);
					const { machines, vm } = await desktop();
					const command = `export DISPLAY=:0; browser=''; for attempt in $(seq 1 120); do browser=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true); test -n "$browser" && break; sleep 1; done; test -n "$browser" || exit 127; nohup "$browser" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/ytimesy-chrome-profile --new-window ${quote(target)} >/tmp/ytimesy-api-browser.log 2>&1 </dev/null &`;
					const result = await machines.exec(vm, command, 135_000);
					if (result.exitCode)
						throw new Error(
							result.exitCode === 127
								? "Chrome did not become available in the task VM. Retry after desktop setup completes."
								: "Could not open the browser page.",
						);
					return { url, status: "opening" };
				}),
		}),
		browser_screenshot: tool({
			description:
				"Capture the task's shared desktop as an image. Do not use this to expose credentials or private account pages unnecessarily.",
			inputSchema: z.object({}),
			execute: async () => {
				const { machines, vm } = await desktop();
				const path = `/tmp/ytimesy-api-screenshot-${randomUUID()}.png`;
				try {
					const result = await machines.exec(
						vm,
						`DISPLAY=:0 scrot -z ${quote(path)} && base64 -w0 ${quote(path)}`,
						20_000,
					);
					if (result.exitCode || !result.stdout)
						throw new Error("Could not capture the shared desktop.");
					if (result.stdout.length > 4_000_000)
						throw new Error(
							"Desktop screenshot is too large for this model tool.",
						);
					return { base64: result.stdout.trim() };
				} finally {
					await machines
						.exec(vm, `rm -f ${quote(path)}`, 10_000)
						.catch(() => {});
				}
			},
			toModelOutput: ({ output }) => ({
				type: "content",
				value: [
					{ type: "text", text: "Shared desktop screenshot" },
					{
						type: "file",
						data: { type: "data", data: output.base64 },
						mediaType: "image/png",
					},
				],
			}),
		}),
	};
	if (input.readOnly) return tools;
	tools.browser_click = tool({
		description:
			"Click coordinates in the shared desktop, then call browser_screenshot to observe the result. Never approve purchases or account changes without user authorization.",
		inputSchema: z.object({
			x: z.number().int().min(0).max(1440),
			y: z.number().int().min(0).max(900),
		}),
		execute: ({ x, y }, options) =>
			once(options.toolCallId, async () => {
				const { machines, vm } = await desktop();
				const result = await machines.exec(
					vm,
					`DISPLAY=:0 xdotool mousemove ${x} ${y} click 1`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Could not click the shared desktop.");
				return { x, y, status: "clicked" };
			}),
	});
	tools.browser_type = tool({
		description:
			"Type ordinary text at the focused control in the shared browser. Do not type passwords, API keys, or other secrets.",
		inputSchema: z.object({ text: z.string().min(1).max(2_000) }),
		execute: ({ text }, options) =>
			once(options.toolCallId, async () => {
				const { machines, vm } = await desktop();
				const result = await machines.exec(
					vm,
					`DISPLAY=:0 xdotool type --clearmodifiers --delay 1 -- ${quote(text)}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Could not type in the shared desktop.");
				return { status: "typed", length: text.length };
			}),
	});
	tools.browser_key = tool({
		description:
			"Press a browser key or shortcut, such as Return, Tab, Escape, Ctrl+l, or Ctrl+r.",
		inputSchema: z.object({
			key: z.enum(["Return", "Tab", "Escape", "BackSpace", "Ctrl+l", "Ctrl+r"]),
		}),
		execute: ({ key }, options) =>
			once(options.toolCallId, async () => {
				const { machines, vm } = await desktop();
				const result = await machines.exec(
					vm,
					`DISPLAY=:0 xdotool key ${quote(key)}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Could not press the browser key.");
				return { key, status: "pressed" };
			}),
	});
	return tools;
}
