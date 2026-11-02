import { Box, Server } from "lucide-react";
import { ClaudeMark } from "./claude-mark";
import { GrokMark } from "./grok-mark";
import icons from "./model-provider-icons.json";
import { XaiMark } from "./xai-mark";

/**
 * The maker of a model from its id: "x-ai/grok-4.7" by its prefix, and a
 * plan's or direct key's bare id ("grok-4.7", "gpt-6.1-sol") by its family.
 */
export function modelLogoProvider(modelId: string) {
	const [prefix, rest] = modelId.split("/", 2);
	if (rest) return rest.startsWith("grok") ? "grok" : prefix;
	const id = modelId.toLowerCase();
	if (id.startsWith("grok")) return "grok";
	if (/^(gpt|o\d|codex|chatgpt)/.test(id)) return "openai";
	if (id.startsWith("claude")) return "anthropic";
	if (id.startsWith("gemini")) return "google";
	if (id.startsWith("deepseek")) return "deepseek";
	if (id.startsWith("qwen")) return "qwen";
	if (id.startsWith("kimi")) return "moonshotai";
	if (/^(llama|muse)/.test(id)) return "meta";
	if (id.startsWith("glm")) return "z-ai";
	return "openrouter";
}

// Curated local subset of Simple Icons 1.2.97 (CC0); no remote image requests.
export function ModelProviderLogo({
	provider,
	size = 18,
}: {
	provider: string;
	size?: number;
}) {
	if (provider === "anthropic") return <ClaudeMark size={size} />;
	if (provider === "custom") return <Server size={size} aria-hidden="true" />;
	if (provider === "x-ai") return <XaiMark size={size} />;
	if (provider === "grok") return <GrokMark size={size} />;
	if (provider === "z-ai")
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 30 30"
				fill="currentColor"
				aria-hidden="true"
			>
				<path d="M15.47 7.1l-1.3 1.85c-.2.29-.54.47-.9.47h-7.1V7.09C6.16 7.1 15.47 7.1 15.47 7.1z" />
				<path d="M24.3 7.1L13.14 22.91H5.7L16.86 7.1z" />
				<path d="M14.53 22.91l1.31-1.86c.2-.29.54-.47.9-.47h7.09v2.33z" />
			</svg>
		);
	const key = provider === "google" ? "googlegemini" : provider;
	const icon: { body: string; width?: number; height?: number } | undefined =
		icons[key as keyof typeof icons];
	// Drawn here rather than with Iconify's <Icon>, which renders nothing on
	// the server and draws after hydration, widening the model button.
	return icon ? (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${icon.width ?? 24} ${icon.height ?? 24}`}
			aria-hidden="true"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: our own bundled icon paths (model-provider-icons.json), no user input.
			dangerouslySetInnerHTML={{ __html: icon.body }}
		/>
	) : (
		<Box size={size} aria-hidden="true" />
	);
}
