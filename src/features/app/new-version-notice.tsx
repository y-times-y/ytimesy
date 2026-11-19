import { RefreshCw } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useNewBuildAvailable } from "./new-build-reload";

/**
 * Bottom right, while this tab runs an older build than the server: one click
 * reloads onto the new one. A tab nobody is using reloads by itself first
 * (new-build-reload.ts); this is for the tab that is in use. The composer's
 * draft survives the reload.
 */
export function NewVersionNotice() {
	const available = useNewBuildAvailable();
	if (!available) return null;
	return <NewVersionCard onUpdate={() => window.location.reload()} />;
}

export function NewVersionCard(props: { readonly onUpdate: () => void }) {
	return (
		<section
			aria-label="New version"
			data-new-version
			className="fixed right-4 bottom-4 z-[250] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border bg-background py-2 pr-2 pl-4 text-sm shadow-lg"
		>
			<p className="flex-1 text-muted-foreground" role="status">
				A new version is available.
			</p>
			<Button type="button" size="sm" onClick={props.onUpdate}>
				<RefreshCw aria-hidden="true" />
				Update
			</Button>
		</section>
	);
}
