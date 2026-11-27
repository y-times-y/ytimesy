import { projectMark } from "#/domain/project-mark";

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
	return (
		<span
			className="project-mark"
			aria-hidden="true"
			data-initials={mark.initials.length}
			style={{
				width: size,
				height: size,
				background: mark.background,
				color: mark.color,
				fontSize: Math.round(size * (mark.initials.length > 1 ? 0.42 : 0.56)),
			}}
		>
			{mark.initials}
		</span>
	);
}
