import { ArrowUp, X } from "lucide-react";
import { useState } from "react";
import type { SessionModel } from "./model-capabilities";
import { ProjectContext } from "./project-context";
import { SessionControls } from "./session-controls";
import { TaskInput } from "./task-input";

export function SessionLauncher({
	models = [],
}: {
	models?: readonly SessionModel[];
}) {
	const [attachments, setAttachments] = useState<File[]>([]);

	return (
		<section className="session-launcher" aria-labelledby="session-title">
			<h1 id="session-title" className="sr-only">
				New session
			</h1>
			<ProjectContext />
			<div className="session-composer">
				<TaskInput />
				{attachments.length > 0 && (
					<ul className="session-attachments" aria-label="Attached files">
						{attachments.map((file, index) => (
							<li key={`${file.name}-${file.lastModified}-${file.size}`}>
								<span title={file.name}>{file.name}</span>
								<button
									type="button"
									aria-label={`Remove ${file.name}`}
									onClick={() =>
										setAttachments((files) =>
											files.filter((_, fileIndex) => fileIndex !== index),
										)
									}
								>
									<X size={14} />
								</button>
							</li>
						))}
					</ul>
				)}
				<div className="session-toolbar">
					<SessionControls
						models={models}
						onAttachFiles={(selected) =>
							setAttachments((files) => {
								const additions = selected.filter(
									(file) =>
										!files.some(
											(existing) =>
												existing.name === file.name &&
												existing.size === file.size &&
												existing.lastModified === file.lastModified,
										),
								);
								return [...files, ...additions];
							})
						}
					/>
					<button
						type="button"
						className="session-send"
						aria-label="Start session"
						disabled
						title="Connect an agent and project during setup to start a session"
					>
						<span className="send-face">
							<ArrowUp className="size-4" />
						</span>
					</button>
				</div>
			</div>
		</section>
	);
}
