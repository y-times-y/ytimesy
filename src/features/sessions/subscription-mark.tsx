import { ClaudeMark } from "./claude-mark";
import { CodexMark } from "./codex-mark";
import { GrokMark } from "./grok-mark";
import "./subscription-mark.css";

export type SubscriptionBrand = "codex" | "claude" | "grok";

/**
 * A subscription's mark in the model picker rail: the brand's glyph on a
 * colored rounded badge, so a plan you signed in with reads apart from the
 * plain API-key provider logos beside it. Codex's own mark is already a
 * filled shape, drawn in its blue.
 */
export function SubscriptionMark({
	brand,
	size = 21,
}: {
	brand: SubscriptionBrand;
	size?: number;
}) {
	if (brand === "codex")
		return (
			<span className="subscription-mark" data-brand="codex">
				<CodexMark size={size} />
			</span>
		);
	const glyph = Math.round(size * 0.62);
	return (
		<span
			className="subscription-mark"
			data-brand={brand}
			style={{ width: size, height: size }}
		>
			{brand === "claude" ? (
				<ClaudeMark size={glyph} />
			) : (
				<GrokMark size={glyph} />
			)}
		</span>
	);
}
