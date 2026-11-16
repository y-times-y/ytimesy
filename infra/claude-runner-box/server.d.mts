import type { KeyObject } from "node:crypto";
import type { Server } from "node:http";

export function runnerSignedMaterial(
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
): string;

export function runnerSignature(
	secret: string,
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
): string;

export function runnerPublicKey(base64: string): KeyObject;

export function createRunnerServer(input: {
	secret?: string;
	publicKey?: string;
	home: string;
	now?: () => number;
	disk?: (home: string) => Promise<number>;
}): Server;

export const DISK_WARN_SHARE: number;
