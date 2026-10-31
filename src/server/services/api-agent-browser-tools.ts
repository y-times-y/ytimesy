import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { publicToolDetail } from "#/domain/tool-detail";
import { browserUseCommand } from "#/server/adapters/browser-use-cli";
import { DESKTOP_X_ENVIRONMENT } from "#/server/adapters/freestyle/start-desktop";
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
import {
	ensureDesktopProcesses,
	publishDesktopViewer,
} from "./workspace-desktop";

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

/**
 * Chrome can open its window unmapped or off screen (x=-1050), where the
 * Desktop tab shows nothing: wait for it, then map, raise and center it
 * above the dock.
 */
const CHROME_WINDOW_SHOWN = `windows=''; for attempt in $(seq 1 30); do windows=$(xdotool search --name ' - Google Chrome$' 2>/dev/null || true); test -n "$windows" && break; sleep 0.5; done; for window in $windows; do xdotool windowmap "$window" windowsize "$window" 1240 780 windowmove "$window" 100 19 >/dev/null 2>&1 || true; done; test -z "$windows" || xdotool windowactivate "$(printf '%s\\n' $windows | tail -n 1)" >/dev/null 2>&1 || true`;

/**
 * Opens a URL (already shell-quoted, or a shell expansion) in the shared
 * desktop's Chrome; exit 127 when Chrome never appears. Chrome starts in its
 * own session so it outlives the agent command that opened it.
 */
export function chromeOpenCommand(quotedUrl: string) {
	return `${DESKTOP_X_ENVIRONMENT}; browser=''; for attempt in $(seq 1 120); do browser=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true); test -n "$browser" && break; sleep 1; done; test -n "$browser" || exit 127; setsid -f nohup "$browser" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --test-type --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/ytimesy-chrome-profile --window-size=1240,780 --window-position=100,19 --new-window ${quotedUrl} >/tmp/ytimesy-api-browser.log 2>&1 </dev/null; ${CHROME_WINDOW_SHOWN}`;
}

export function apiAgentBrowserTools(
	input: AgentToolWorkspaceInput & {
		readOnly: boolean;
		sessionId?: string;
		executeCommand?: NonNullable<ToolSet[string]["execute"]>;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
	},
): ToolSet {
	const { signal, once } = input;
	let viewerExposed: Promise<unknown> | undefined;
	async function desktop() {
		signal.throwIfAborted();
		const workspace = await resolveToolWorkspace(input);
		const { machines, vm } = workspace;
		const result = await ensureDesktopProcesses(machines, vm);
		if (result.exitCode)
			throw new Error(
				`The shared desktop could not start (exit ${result.exitCode}). ${publicToolDetail(`${result.stderr}\n${result.stdout}`.trim()).slice(-1200)}`.trim(),
			);
		// Route the Desktop tab's viewer to a desktop the agent started, as the
		// tab's own start does. Viewing is optional; the agent's QA is not.
		viewerExposed ??= publishDesktopViewer(machines, vm).catch(() => undefined);
		await viewerExposed;
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
					const result = await machines.exec(
						vm,
						chromeOpenCommand(quote(target)),
						135_000,
					);
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
						`${DESKTOP_X_ENVIRONMENT}; scrot -z ${quote(path)} && base64 -w0 ${quote(path)}`,
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
	if (input.sessionId && input.executeCommand) {
		const sessionId = input.sessionId;
		const executeCommand = input.executeCommand;
		tools.browser_execute = tool({
			description:
				"Run Browser Use CLI Python in this task VM's shared Chrome (no separate paid browser or model). Helpers: new_tab(url), page_info(), js(code), cdp(method, **params), fill_input(selector,text), click_at_xy(x,y), wait_for_load(), capture_screenshot(path). Open one task tab and reuse it across calls. Inspect AX/DOM, interact, then assert the outcome; use browser_screenshot for pixels. Read CLI help/skill through execute_command if needed. Never expose secrets or approve account changes without permission. Commands may yield: continue_command resumes the returned id; never restart it. Only writable builders can execute Python.",
			inputSchema: z.object({
				code: z.string().min(1).max(12000),
				maxSeconds: z.number().int().min(30).max(600).default(300),
			}),
			execute: async ({ code, maxSeconds }, options) => {
				await desktop();
				return executeCommand(
					{
						command: browserUseCommand(sessionId, code),
						maxSeconds,
						yieldSeconds: 1,
					},
					options,
				);
			},
		});
	}
	return tools;
}
