import { projectMark } from "#/domain/project-mark";

const SINGLE_LETTER_BELOW = 20;

/**
 * The project's mark: its initials on a tile that follows the project id.
 * Drawn from text and CSS only (no image to load, fail or shift), the same
 * wherever the project appears. The project has no uploaded logo in ytimesy
 * and the repository owner's GitHub avatar is deliberately not used.
 */
export function ProjectMark({
	project,
	size = 16,
}: {
	project: { id: string; name: string };
	size?: number;
}) {
	const mark = projectMark(project);
	// Small tiles hold one letter: two would need text under 11px.
	const initials =
		size < SINGLE_LETTER_BELOW ? Array.from(mark.initials)[0] : mark.initials;
	return (
		<span
			className="project-mark"
			aria-hidden="true"
			data-initials={initials?.length}
			style={{
				width: size,
				height: size,
				background: mark.background,
				color: mark.color,
				fontSize: Math.max(11, Math.round(size * 0.56)),
			}}
		>
			{initials}
		</span>
	);
}
