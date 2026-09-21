import { addCollection, Icon } from "@iconify/react";
import { vscodeFileIconName } from "#/domain/file-kind";
import catppuccinFileIcons from "./catppuccin-file-icons.json";
import vscodeFileIcons from "./vscode-file-icons.json";

addCollection(vscodeFileIcons as Parameters<typeof addCollection>[0]);
addCollection(catppuccinFileIcons as Parameters<typeof addCollection>[0]);

export function FileTypeIcon({
	path,
	size = 16,
}: {
	path: string;
	size?: number;
}) {
	return (
		<Icon
			icon={vscodeFileIconName(path)}
			width={size}
			height={size}
			className="file-type-icon"
			aria-hidden="true"
		/>
	);
}
