import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
	CodexSection,
	codexCatalogKey,
	HarnessPicker,
	prefetchCodexCatalog,
} from "./harness-picker";
import { sessionModelsFromListed } from "./model-capabilities";

describe("Codex catalog prefetch", () => {
	it("starts one catalog read under the composer's own key", async () => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "prefetchQuery");
		const load = vi.fn(async () => [{ id: "gpt-x", label: "GPT X" }]);
		await Promise.all([
			prefetchCodexCatalog(client, "u1", load),
			prefetchCodexCatalog(client, "u1", load),
		]);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenCalledTimes(1);
		expect(client.getQueryData(codexCatalogKey("u1"))).toEqual([
			{ id: "gpt-x", label: "GPT X" },
		]);
	});
	it("does nothing before the user is known", async () => {
		const client = new QueryClient();
		const load = vi.fn(async () => []);
		await prefetchCodexCatalog(client, undefined, load);
		expect(load).not.toHaveBeenCalled();
	});
});

const apiModels = sessionModelsFromListed([
	{ id: "route:c1/openrouter/claude-api-x", label: "API Claude X" },
	{ id: "route:c1/gpt-api-y", label: "API GPT Y" },
]);
const codexModels = sessionModelsFromListed([
	{ id: "gpt-plan-z", label: "Plan GPT Z" },
]);
function section(props: Partial<ComponentProps<typeof CodexSection>>): string {
	return renderToStaticMarkup(
		createElement(CodexSection, {
			models: [],
			visibleModels: [],
			status: "ready",
			search: "",
			modelId: "",
			modelsEnabled: true,
			providerConnected: false,
			onSelect: () => {},
			...props,
		}),
	);
}

describe("Codex section states (never API models)", () => {
	it("loading: skeleton rows, aria-busy, no model labels", () => {
		const html = section({ status: "loading" });
		expect(html).toContain("model-picker-skeleton");
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("API Claude X");
		expect(html).not.toContain("API GPT Y");
	});
	it("error: the error row with a retry", () => {
		const html = section({ status: "error", onRetry: () => {} });
		expect(html).toContain("Could not load saved models");
		expect(html).toContain("Retry");
		expect(html).not.toContain("model-picker-skeleton");
		expect(html).not.toContain("API Claude X");
	});
	it("not connected: the connect prompt", () => {
		const html = section({ onRetry: () => {} });
		expect(html).toContain("Connect this provider once");
		expect(html).toContain("Connect provider");
	});
	it("ready: the plan's models, under Codex", () => {
		const html = section({ models: codexModels, visibleModels: codexModels });
		expect(html).toContain("Plan GPT Z");
		expect(html).toContain("<h3>Codex</h3>");
		expect(html).not.toContain("API Claude X");
	});
});

describe("picker with an API harness active", () => {
	it("the trigger does not leak the API list into a closed Codex view", () => {
		const html = renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client: new QueryClient() },
				createElement(HarnessPicker, {
					harnessId: "api",
					onHarnessIdChange: () => {},
					onModelIdChange: () => {},
					modelsEnabled: true,
					models: apiModels,
					modelId: "",
				}),
			),
		);
		expect(html).toContain("Select model");
	});
});
