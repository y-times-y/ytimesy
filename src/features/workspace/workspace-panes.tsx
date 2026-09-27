import { Children, type ReactNode, useLayoutEffect } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";

export function WorkspacePanes({
	children,
	open,
	compact,
	ratio,
	view,
	layout,
	onResize,
	onReset,
}: {
	children: ReactNode;
	open: boolean;
	compact: boolean;
	ratio: number;
	view: string;
	layout: string;
	onResize: (ratio: number) => void;
	onReset: () => void;
}) {
	const groupRef = useGroupRef();
	const [chat, inspector] = Children.toArray(children);
	const chatSize = !open ? 100 : compact ? 0 : ratio * 100;
	useLayoutEffect(() => {
		groupRef.current?.setLayout({ chat: chatSize, inspector: 100 - chatSize });
	}, [chatSize, groupRef]);
	return (
		<Group
			groupRef={groupRef}
			className="workspace-body"
			orientation={compact ? "vertical" : "horizontal"}
			disabled={!open || compact}
			defaultLayout={{ chat: chatSize, inspector: 100 - chatSize }}
			data-inspector-collapsed={!open}
			data-inspector-view={view}
			data-layout={layout}
			onLayoutChanged={(next, meta) => {
				if (meta.isUserInteraction && open && !compact)
					onResize(next.chat / 100);
			}}
		>
			<Panel
				id="chat"
				minSize={open && !compact ? "32%" : 0}
				maxSize={open && !compact ? "72%" : "100%"}
				collapsible={!open || compact}
				collapsedSize={0}
			>
				{chat}
			</Panel>
			{open && !compact ? (
				<Separator
					className="workspace-separator"
					aria-label="Resize tools panel"
					disableDoubleClick
					onDoubleClick={onReset}
				/>
			) : null}
			<Panel
				id="inspector"
				minSize={open && !compact ? "28%" : 0}
				collapsible={!open || compact}
				collapsedSize={0}
			>
				{inspector}
			</Panel>
		</Group>
	);
}
