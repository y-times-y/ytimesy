import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { API_MODEL_LIST } from "#/domain/api-model-list";
import {
	modelRouteId,
	type PublicModelConnection,
} from "#/domain/model-connection";
import { ApiModelBrowser } from "./api-model-browser";
import { ClaudeCodeModels } from "./harness-picker";
import { ModelFavoriteButton } from "./model-favorite-button";
import { favoriteModelKey } from "./model-picker-favorites";

describe("model favorite controls", () => {
	it("renders an independent favorite control for Claude subscription models", () => {
		const html = renderToStaticMarkup(
			createElement(ClaudeCodeModels, {
				models: [{ id: "claude-code/fixture", label: "Subscription fixture" }],
				selectedRoute: "",
				onSelect: () => {},
				renderFavorite: (_id, label) =>
					createElement(ModelFavoriteButton, {
						label,
						favorite: false,
						onToggle: () => {},
					}),
			}),
		);
		expect(html).toContain('aria-label="Favorite Subscription fixture"');
		expect(html).toContain('aria-pressed="false"');
	});

	it.each(["openai", "anthropic", "google", "x-ai"] as const)(
		"offers stars in the %s model list",
		(author) => {
			const model = API_MODEL_LIST.find(
				(entry) => entry.author === author && entry.directId,
			);
			if (!model?.directId)
				throw new Error(`Missing fixture model for ${author}`);
			const client = new QueryClient();
			const connection: PublicModelConnection = {
				id: "33333333-3333-4333-8333-333333333333",
				label: "Fixture",
				revision: "fixture",
				provider: author === "x-ai" ? "compatible" : author,
				baseUrl:
					author === "x-ai"
						? "https://api.x.ai/v1"
						: `https://api.${author}.com/v1`,
				models: [
					{
						id: model.directId,
						label: model.label,
						toolStreamingVerified: true,
					},
				],
				...(author === "x-ai"
					? {
							subscription: {
								provider: "xai" as const,
								status: "ready" as const,
							},
						}
					: {}),
			};
			client.setQueryData(["model-connections"], [connection]);
			client.setQueryData(["browse-models"], []);
			const html = renderToStaticMarkup(
				createElement(
					QueryClientProvider,
					{ client },
					createElement(ApiModelBrowser, {
						author,
						search: "",
						source: author === "x-ai" ? "plan" : "keys",
						onSelect: () => {},
						renderFavorite: (_id, label) =>
							createElement(ModelFavoriteButton, {
								label,
								favorite: false,
								onToggle: () => {},
							}),
					}),
				),
			);
			expect(html).toContain(`aria-label="Favorite ${model.label}"`);
		},
	);

	it("lists favorites from every saved API connection, not just the preferred one", () => {
		const client = new QueryClient();
		const connection = (id: string, label: string): PublicModelConnection => ({
			id,
			label,
			provider: "compatible",
			baseUrl: "https://models.example/v1",
			models: [
				{
					id: "aurora-9",
					label: "Aurora Nine",
					toolStreamingVerified: true,
					contextWindow: 64000,
				},
			],
			revision: "fixture",
		});
		const first = connection("11111111-1111-4111-8111-111111111111", "First");
		const second = connection("22222222-2222-4222-8222-222222222222", "Second");
		client.setQueryData(["model-connections"], [first, second]);
		client.setQueryData(["browse-models"], []);
		const route = modelRouteId(second.id, "aurora-9");
		const html = renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(ApiModelBrowser, {
					author: null,
					search: "",
					selectedRoute: modelRouteId(first.id, "aurora-9"),
					onSelect: () => {},
					favoriteIds: [favoriteModelKey("api", route)],
					renderFavorite: (id, label) =>
						createElement(ModelFavoriteButton, {
							label,
							favorite: id === route,
							onToggle: () => {},
						}),
				}),
			),
		);
		expect(html).toContain('aria-label="Unfavorite Aurora Nine"');
		expect(html.match(/class="model-favorite"/g)).toHaveLength(1);
		expect(html).not.toContain("Connect a key above");
	});
});
