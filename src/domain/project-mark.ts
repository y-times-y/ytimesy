/** Tiles dark enough for white text at WCAG AA (4.5:1), muted to sit in the dark theme. */
export const PROJECT_MARK_TONES = [
	"#3d5a9e",
	"#2b7556",
	"#94397f",
	"#6650ab",
	"#a3435b",
	"#1f7077",
	"#9a5a2a",
	"#52647a",
] as const;

const graphemes = (text: string) => Array.from(text);

/** One letter from a one-word name, the first two words' letters from a longer one. */
export function projectMarkInitials(name: string): string {
	const words = name
		.split(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/u)
		.filter(Boolean);
	const letters = words.slice(0, 2).map((word) => graphemes(word)[0] ?? "");
	return letters.join("").toUpperCase() || "#";
}

function hash(seed: string) {
	let value = 0;
	for (const char of seed) value = (value * 31 + char.charCodeAt(0)) >>> 0;
	return value;
}

/** The default project mark: the tone follows the id (stable across renames), the letters the name. */
export function projectMark(project: { id: string; name: string }) {
	return {
		initials: projectMarkInitials(project.name),
		background: PROJECT_MARK_TONES[
			hash(project.id) % PROJECT_MARK_TONES.length
		] as string,
		color: "#ffffff",
	};
}
