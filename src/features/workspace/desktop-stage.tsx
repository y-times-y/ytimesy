import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";
import { desktopClientViewerUrl } from "#/domain/workspace-desktop";

export function DesktopStage({
	projectId,
	sessionId,
}: {
	projectId: string;
	sessionId: string;
}) {
	const host = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const target = host.current;
		if (!target) return;
		const protocol = window.location.protocol === "https:" ? "wss" : "ws";
		const path = desktopClientViewerUrl({ projectId, sessionId });
		const rfb = new RFB(
			target,
			`${protocol}://${window.location.host}${path}`,
		);
		rfb.scaleViewport = true;
		rfb.clipViewport = true;
		rfb.resizeSession = false;
		rfb.showDotCursor = true;
		rfb.background = "#111111";
		return () => {
			try {
				rfb.disconnect();
			} catch {
				target.replaceChildren();
			}
		};
	}, [projectId, sessionId]);

	return <div className="desktop-stage-rfb" ref={host} />;
}
