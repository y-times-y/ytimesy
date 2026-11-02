import "./first-project-heading.css";

/**
 * Above the composer until the account has a project: the mark and one line.
 * The composer's repository pill below it is the action; nothing here is.
 */
export function FirstProjectHeading() {
	return (
		<div className="first-project-heading">
			<span className="first-project-mark">
				<img src="/brand/mark.svg" width={22} height={22} alt="" />
			</span>
			<h2>Pick a repository to start</h2>
		</div>
	);
}
