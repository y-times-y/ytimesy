import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Check, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { firstBuildRunning } from "#/domain/project-setup-start";
import {
	activeSetupPill,
	readyShownUntil,
	type SetupPill,
	setupPillForChat,
} from "#/domain/setup-pill";
import type { ChatWaitingOn } from "#/domain/sidebar-chats";
import { useEnvironmentProgress, useNow } from "./environment-build-progress";
import {
	workspaceStatusIsLive,
	workspaceStatusQuery,
} from "./workspace-status";

/**
 * The project setup's pill for the open chat (null when there is none):
 * read from the project's status and its build's steps, the setup card's
 * data. "Ready" shows for a moment once an active pill goes away.
 */
export function useSetupPill(input: {
	readonly projectId: string | undefined;
	readonly setupChat: {
		readonly id: string;
		readonly turnStatus?: string;
		readonly waitingOn?: ChatWaitingOn | null;
		readonly waitsForSetup?: boolean;
	} | null;
	readonly openChatId: string | undefined;
}): SetupPill | null {
	const projectId = input.projectId ?? "";
	const workspace = useQuery({
		...workspaceStatusQuery(projectId),
		enabled: Boolean(projectId),
		refetchInterval: (query) =>
			workspaceStatusIsLive(query.state.data) ? 3000 : false,
	}).data;
	const current =
		workspace && workspace.projectId === projectId ? workspace : null;
	const building = Boolean(current && firstBuildRunning(current));
	const progress = useEnvironmentProgress(projectId, {
		enabled: building,
		waiting: building,
	});
	const agentWorking =
		input.setupChat?.turnStatus === "running" ||
		Boolean(input.setupChat?.waitsForSetup);
	const now = useNow(building || agentWorking);
	const active = activeSetupPill({
		workspace: current,
		build: building ? (progress.data?.build ?? null) : null,
		steps: building ? (progress.data?.steps ?? []) : [],
		setupChat: input.setupChat,
		now,
	});
	const activeKind = active?.kind ?? null;
	// Per project: a switch never carries another project's "Ready".
	const previous = useRef<{
		projectId: string;
		kind: SetupPill["kind"] | null;
	} | null>(null);
	const [ready, setReady] = useState<{
		projectId: string;
		until: number;
	} | null>(null);
	useEffect(() => {
		const was =
			previous.current?.projectId === projectId ? previous.current.kind : null;
		previous.current = { projectId, kind: activeKind };
		setReady((shown) => {
			const until = readyShownUntil({
				previous: was,
				next: activeKind,
				current: shown?.projectId === projectId ? shown.until : null,
				now: Date.now(),
			});
			return until === null ? null : { projectId, until };
		});
	}, [activeKind, projectId]);
	// "Ready" goes once its moment is over.
	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(
			() => setReady(null),
			Math.max(0, ready.until - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [ready]);
	return setupPillForChat({
		active,
		readyUntil: ready?.projectId === projectId ? ready.until : null,
		now: Date.now(),
		setupChatId: input.setupChat?.id ?? null,
		openChatId: input.openChatId,
	});
}

const PILL_ICON = {
	running: <LoaderCircle size={12} className="workspace-status-spin" />,
	ready: <Check size={12} />,
	failed: <AlertCircle size={12} />,
} as const;

/** The pill in the chat's top bar, beside the right panel's toggle. */
export function SetupStatusPill({
	pill,
	onOpen,
}: {
	pill: SetupPill;
	/** Opens the setup's progress (or its chat); absent for "Ready". */
	onOpen?: () => void;
}) {
	const icon =
		pill.kind === "needs-you" ? <KeyRound size={12} /> : PILL_ICON[pill.kind];
	const label = (
		<>
			<span className="setup-pill-icon" aria-hidden="true">
				{icon}
			</span>
			<span className="setup-pill-text">{pill.text}</span>
			{pill.kind === "running" && pill.elapsed ? (
				<span className="setup-pill-time">{pill.elapsed}</span>
			) : null}
		</>
	);
	return onOpen && pill.kind !== "ready" ? (
		<button
			type="button"
			className="setup-pill"
			data-kind={pill.kind}
			onClick={onOpen}
			title="Show the project's setup"
		>
			{label}
		</button>
	) : (
		<span className="setup-pill" data-kind={pill.kind} role="status">
			{label}
		</span>
	);
}
