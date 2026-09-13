import { File } from "lucide-react";
import { fileKindBadge, fileKindFromPath } from "#/domain/file-kind";

export function FileTypeIcon({ path }: { path: string }) {
	const kind = fileKindFromPath(path);
	const badge = fileKindBadge(kind);
	if (!badge) {
		return <File size={16} aria-hidden="true" />;
	}
	return (
		<span className="file-type-icon" data-kind={kind} aria-hidden="true">
			{badge}
		</span>
	);
}
