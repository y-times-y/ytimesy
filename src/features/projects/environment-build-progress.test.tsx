import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { EnvironmentBuildProgress } from "#/domain/environment-build-progress";
import {
	environmentProgressQuery,
	HeldForSetupMessage,
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
	props: { failed: boolean; showMessage?: boolean; setUp?: boolean },
) {
	const client = new QueryClient();
	client.setQueryData(environmentProgressQuery("p").queryKey, progress);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<HeldForSetupMessage
				projectId="p"
				text="Add a login page"
				showMessage={props.showMessage ?? true}
				failed={props.failed}
				actions={{
					pending: false,
					onRetry: noop,
					onSendAnyway: noop,
					...(props.setUp ? { onSetUpWithAgent: noop } : {}),
				}}
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

const running: EnvironmentBuildProgress = {
	build: {
		id: "b",
		status: "running",
		rebuild: false,
		startedAt: started,
		completedAt: null,
		errorMessage: null,
		failure: null,
	},
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
	expect(html).toContain("Setting up your project");
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
	expect(html).toContain("Set up with the agent");
});

it("offers Set up with the agent only for a new chat's first message", () => {
	const html = text(
		render({ build: null, steps: [] }, { failed: true, setUp: false }),
	);
	expect(html).toContain("Setup did not finish.");
	expect(html).toContain("Send anyway");
	expect(html).not.toContain("Set up with the agent");
});
