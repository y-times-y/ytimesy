import { readBoundedRequestBody } from "./bounded-request-body";
import { verifyDeliveryRequest } from "./delivery-auth";
import { type WorkflowStep, workflowStepSchema } from "./model-workflow";

type ModelConversationScope = { userId: string; sessionId: string };

export function modelConversationName(scope: ModelConversationScope) {
	return JSON.stringify([scope.userId, scope.sessionId]);
}

/** Authenticate references before database access; ownership is never taken from the caller. */
export async function routeModelConversationStep(
	request: Request,
	secret: string,
	resolve: (step: WorkflowStep) => Promise<ModelConversationScope | null>,
	forward: (
		scope: ModelConversationScope,
		request: Request,
	) => Promise<Response>,
) {
	if (
		request.method !== "POST" ||
		new URL(request.url).pathname !== "/model-step"
	)
		return new Response(null, { status: 404 });
	let body: string;
	try {
		body = await readBoundedRequestBody(request, 1024);
	} catch {
		return new Response(null, { status: 413 });
	}
	if (!(await verifyDeliveryRequest(secret, request, body)))
		return new Response(null, { status: 401 });
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return new Response(null, { status: 400 });
	}
	const step = workflowStepSchema.safeParse(value);
	if (!step.success) return new Response(null, { status: 400 });
	const scope = await resolve(step.data);
	if (!scope) return new Response(null, { status: 409 });
	return forward(
		scope,
		new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body,
			signal: request.signal,
		}),
	);
}
