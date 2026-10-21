import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { vmEdgeRouteKind } from "#/domain/vm-edge-routes";
import {
	LIST_LISTENING_PORTS,
	parseListeningPorts,
	previewPortAllowed,
	type WorkspacePreviews,
} from "#/domain/workspace-preview";
import { previewGrants } from "../adapters/preview-grants";
import { serverConfig } from "../config";
import {
	EDGE_AUTHORIZER_HEADER,
	edgeAuthorizerKey,
	edgeAuthorizerUrl,
	PREVIEW_COOKIE,
	previewLoginUrl,
} from "./vm-edge-auth";
import { previewHostname, sharedPreviewHostname } from "./vm-edge-keys";
import {
	type DesktopScope,
	ensureSessionMachine,
	peekSessionMachineRef,
} from "./workspace-desktop";
import type { WorkspaceMachines } from "./workspace-machines";

type PreviewMachines = WorkspaceMachines &
	Required<
		Pick<
			WorkspaceMachines,
			| "publishHttpRoute"
			| "listHttpRoutes"
			| "withdrawHttpRoutes"
			| "ensureEdgeAuthorizer"
		>
	>;

export function previewMachines(machines: WorkspaceMachines): PreviewMachines {
	const {
		publishHttpRoute,
		listHttpRoutes,
		withdrawHttpRoutes,
		ensureEdgeAuthorizer,
	} = machines;
	if (
		!publishHttpRoute ||
		!listHttpRoutes ||
		!withdrawHttpRoutes ||
		!ensureEdgeAuthorizer
	)
		throw new Error("This workspace provider cannot publish previews.");
	return {
		...machines,
		publishHttpRoute,
		listHttpRoutes,
		withdrawHttpRoutes,
		ensureEdgeAuthorizer,
	};
}

/** Listening user-app ports on the chat's machine; never starts a sleeping one. */
export async function listWorkspacePreviews(
	machines: PreviewMachines,
	scope: DesktopScope,
): Promise<WorkspacePreviews> {
	const providerRef = await peekSessionMachineRef(scope);
	if (!providerRef)
		return {
			status: "unavailable",
			reason: "Start a chat with a workspace to preview its apps.",
		};
	const vm = WorkspaceId(providerRef);
	if (!(await machines.isRunning(vm))) return { status: "asleep" };
	const [listening, routes] = await Promise.all([
		machines.exec(vm, LIST_LISTENING_PORTS, 15_000),
		machines.listHttpRoutes(vm),
	]);
	const shared = new Map(
		routes
			.filter((route) => vmEdgeRouteKind(route.domain) === "share")
			.map((route) => [route.port, `https://${route.domain}`]),
	);
	return {
		status: "ready",
		ports: parseListeningPorts(listening.stdout).map((port) => ({
			...port,
			shareUrl: shared.get(port.port) ?? null,
		})),
	};
}

function requirePreviewPort(port: number) {
	if (!previewPortAllowed(port))
		throw new Error("That port cannot be previewed.");
}

/**
 * Publishes the port behind forward auth and returns a two-minute link that
 * signs this browser in to it (an 8-hour cookie scoped to that one route).
 * Starts the chat's machine when it is asleep.
 */
export async function openWorkspacePreview(
	machines: PreviewMachines,
	scope: DesktopScope,
	port: number,
) {
	requirePreviewPort(port);
	const providerRef = await Effect.runPromise(
		ensureSessionMachine(machines, scope),
	);
	if (!providerRef) throw new Error("Start a chat with a workspace first.");
	const authorizer = await machines.ensureEdgeAuthorizer({
		url: edgeAuthorizerUrl(serverConfig().APP_URL),
		headers: { [EDGE_AUTHORIZER_HEADER]: edgeAuthorizerKey() },
		protectedCookies: [PREVIEW_COOKIE],
	});
	const route = await machines.publishHttpRoute(WorkspaceId(providerRef), {
		hostname: previewHostname(providerRef, port),
		port,
		forwardAuthId: authorizer,
	});
	if (!scope.projectId || !scope.sessionId)
		throw new Error("Open a chat to preview its apps.");
	return {
		url: await previewLoginUrl(route.origin, {
			ruleId: route.ruleId,
			userId: scope.userId,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
		}),
	};
}

/** Turns the port's public link on (anyone with it can open the app) or off. */
export async function setWorkspacePreviewSharing(
	machines: PreviewMachines,
	scope: DesktopScope,
	port: number,
	shared: boolean,
) {
	requirePreviewPort(port);
	const providerRef = await peekSessionMachineRef(scope);
	if (!providerRef) throw new Error("Start a chat with a workspace first.");
	const vm = WorkspaceId(providerRef);
	if (!shared) {
		await machines.withdrawHttpRoutes(vm, ["share"], port);
		// Access withdrawn: signed-in preview cookies for this chat stop working too.
		if (scope.projectId && scope.sessionId)
			await previewGrants.revokeScope({
				userId: scope.userId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
			});
		return { shareUrl: null };
	}
	const route = await machines.publishHttpRoute(vm, {
		hostname: sharedPreviewHostname(providerRef, port),
		port,
	});
	return { shareUrl: route.origin };
}
