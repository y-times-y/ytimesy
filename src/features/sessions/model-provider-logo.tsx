import { Icon } from "@iconify/react";
import { Box } from "lucide-react";
import { ClaudeMark } from "./claude-mark";
import icons from "./model-provider-icons.json";
import { XaiMark } from "./xai-mark";

// Curated local subset of Simple Icons 1.2.97 (CC0); no remote image requests.
export function ModelProviderLogo({
	provider,
	size = 18,
}: {
	provider: string;
	size?: number;
}) {
	if (provider === "anthropic") return <ClaudeMark size={size} />;
	if (provider === "x-ai") return <XaiMark size={size} />;
	const key = provider === "google" ? "googlegemini" : provider;
	const icon = icons[key as keyof typeof icons];
	return icon ? (
		<Icon icon={icon} width={size} height={size} aria-hidden="true" />
	) : (
		<Box size={size} aria-hidden="true" />
	);
}
