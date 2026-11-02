import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { EnvironmentBuildProgress } from "#/domain/environment-build-progress";
import { ENVIRONMENT_SETUP_PROMPT } from "#/domain/environment-setup";
import {
	environmentProgressQuery,
	HeldForSetupMessage,
	SetupProjectContext,
	SetupRequestItem,
} from "./environment-build-progress";

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ");
const noop = () => undefined;
const started = "2026-11-01T10:00:00.000Z";

function render(
	progress: EnvironmentBuildProgress,
	props: {
		failed: boolean;
		showMessage?: boolean;
		setUp?: boolean;
		stored?: boolean;
		text?: string;
	},
) {
	const client = new QueryClient();
	client.setQueryData(environmentProgressQuery("p").queryKey, progress);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<HeldForSetupMessage
				projectId="p"
				text={props.text ?? "Add a login page"}
				showMessage={props.showMessage ?? true}
				failed={props.failed}
				actions={{
					pending: false,
					onRetry: noop,
					onSendAnyway: noop,
					...(props.setUp ? { onSetUpWithAgent: noop } : {}),
				}}
				{...(props.stored ? { onEdit: noop, onRemove: noop } : {})}
			/>
		</QueryClientProvider>,
	);
}

const step = (
	key: string,
	label: string,
	state: "running" | "done" | "failed" | "skipped",
	extra: Partial<EnvironmentBuildProgress["steps"][number]> = {},
) => ({
	key,
	label,
	command: null,
	state,
	exitCode: null,
	output: null,
	note: null,
	startedAt: started,
	completedAt: state === "running" ? null : "2026-11-01T10:00:04.000Z",
	...extra,
});

const runningBuild = {
	id: "b",
	status: "running" as const,
	rebuild: false,
	startedAt: started,
	completedAt: null,
	errorMessage: null,
	failure: null,
};
const running: EnvironmentBuildProgress = {
	build: runningBuild,
	steps: [
		step("machine", "Starting machine", "done"),
		step("clone:1", "Cloning org/app", "done"),
		step("install:1", "Installing dependencies", "running", {
			command: "corepack pnpm install --frozen-lockfile",
			output: "Progress: resolved 412, reused 400",
		}),
	],
};

it("shows a held message as sent and waiting, with the setup streaming below it", () => {
	const html = text(render(running, { failed: false }));
	expect(html).toContain("Add a login page");
	expect(html).toContain("Waiting for setup");
	expect(html).toContain("Setting up project");
	expect(html).toContain("Starting machine");
	expect(html).toContain("Cloning org/app");
	expect(html).toContain("corepack pnpm install --frozen-lockfile");
	expect(html).toContain("Progress: resolved 412, reused 400");
	expect(html).toContain("4s");
	expect(html).not.toContain("Retry");
});

it("leaves the message to the transcript when it already shows it", () => {
	const html = text(render(running, { failed: false, showMessage: false }));
	expect(html).not.toContain("Add a login page");
	expect(html).toContain("Waiting for setup");
});

it("keeps a held message after a failed setup, with the real error and what to do", () => {
	const failure = {
		step: "Installing dependencies",
		command: "npm ci",
		exitCode: 1,
		output: "npm ERR! missing: react@19",
	};
	const html = text(
		render(
			{
				build: {
					id: "b",
					status: "failed",
					rebuild: false,
					startedAt: started,
					completedAt: started,
					errorMessage: "Installing dependencies: npm ci failed (exit 1)",
					failure,
				},
				steps: [
					step("machine", "Starting machine", "done"),
					step("install:1", "Installing dependencies", "failed", {
						command: "npm ci",
						exitCode: 1,
					}),
				],
			},
			{ failed: true, setUp: true },
		),
	);
	expect(html).toContain("Add a login page");
	expect(html).toContain("Not sent: setup failed");
	expect(html).toContain("Installing dependencies: npm ci failed (exit 1)");
	expect(html).toContain("npm ERR! missing: react@19");
	expect(html).toContain("exit 1");
	expect(html).toContain("Retry");
	expect(html).toContain("Send anyway");
	expect(html).toContain("Fix with the agent");
});

it("offers Fix with the agent only for a new chat's first message", () => {
	const html = text(
		render({ build: null, steps: [] }, { failed: true, setUp: false }),
	);
	expect(html).toContain("Setup did not finish.");
	expect(html).toContain("Send anyway");
	expect(html).not.toContain("Fix with the agent");
});

it("shows a stored held message (after a reload) with Edit and Remove beside the live setup", () => {
	const html = render(running, { failed: false, stored: true });
	expect(text(html)).toContain("Add a login page");
	expect(text(html)).toContain("Waiting for setup");
	expect(html).toContain('aria-label="Edit held message"');
	expect(html).toContain('aria-label="Remove held message"');
	expect(text(html)).toContain("Installing dependencies");
	// The composer's own copy shows the text: no second Edit there.
	const inline = render(running, {
		failed: false,
		stored: true,
		showMessage: false,
	});
	expect(inline).not.toContain("Edit held message");
});

const streamed: EnvironmentBuildProgress = {
	...running,
	steps: [
		step("machine", "Starting machine", "done"),
		step("clone:1", "Cloning org/app", "done"),
		step("detect:1", "Detecting the stack", "done", { note: "Node (pnpm)" }),
		...running.steps.slice(2),
	],
};

it("shows a new project's setup as one line and streams the build under it, nothing to type", () => {
	const html = text(
		render(streamed, {
			failed: false,
			showMessage: true,
			stored: true,
			text: ENVIRONMENT_SETUP_PROMPT,
		}),
	);
	expect(html).toContain("Set up project");
	// The request's own paragraph never shows, nor Edit for it.
	expect(html).not.toContain("environment report");
	expect(html).not.toContain("Waiting for setup");
	expect(html).not.toContain("Edit");
	expect(html).toContain("Setting up project");
	// Every step, with its time: cloning, the stack, the running install's tail.
	expect(html).toMatch(/Cloning org\/app 4s/);
	expect(html).toMatch(/Detecting the stack Node \(pnpm\) · 4s/);
	expect(html).toContain("Installing dependencies");
	expect(html).toContain("Progress: resolved 412, reused 400");
});

function renderSent(progress: EnvironmentBuildProgress) {
	const client = new QueryClient();
	client.setQueryData(environmentProgressQuery("p").queryKey, progress);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<SetupProjectContext.Provider value="p">
				<SetupRequestItem />
			</SetupProjectContext.Provider>
		</QueryClientProvider>,
	);
}

it("keeps the finished build in the setup chat, folded to its ready line and total time", () => {
	const html = renderSent({
		build: {
			id: "b",
			status: "ready",
			rebuild: false,
			startedAt: started,
			completedAt: "2026-11-01T10:00:43.000Z",
			errorMessage: null,
			failure: null,
		},
		steps: [
			step("clone:1", "Cloning org/app", "done"),
			step("ready", "Saving the environment", "done"),
		],
	});
	expect(html).toContain("<details");
	expect(text(html)).toContain("Set up project");
	expect(text(html)).toContain("Environment ready 43s");
	expect(text(html)).toContain("Saving the environment");
});

it("shows the rebuild from the setup the agent saved, live, in the same chat", () => {
	const html = text(
		renderSent({
			...running,
			build: { ...runningBuild, rebuild: true },
		}),
	);
	expect(html).toContain("Updating the environment");
	expect(html).toContain("Installing dependencies");
});
