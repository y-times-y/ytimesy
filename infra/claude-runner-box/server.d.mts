import type { Server } from "node:http";

export function runnerSignature(
	secret: string,
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
): string;

export function createRunnerServer(input: {
	secret: string;
	home: string;
	now?: () => number;
}): Server;
