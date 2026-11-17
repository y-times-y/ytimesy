import { z } from "zod";
import { machineSizeId } from "./machine-size";
import { TURN_BOX_API_PREFIX } from "./turn-box-protocol";
import { vmNetworkPolicy } from "./vm-network-policy";

/**
 * The `vm/*` half of the thin-client box API (docs/turn-runner-boxes.md,
 * "Workspace tools from a box"): what a turn runner box asks the edge for
 * when it runs a turn's workspace tool calls against the chat's Freestyle VM
 * without holding any Freestyle account key. Every path is authenticated by
 * the turn grant, like the stage-1 paths.
 */
export const TURN_BOX_VM_PATHS = {
	/** Start/resume the chat's VM (admission included) and mint the turn's scoped identity. */
	ensure: `${TURN_BOX_API_PREFIX}/vm/ensure`,
	/** Pause the VM while the model thinks (the edge checks nothing else needs it). */
	pause: `${TURN_BOX_API_PREFIX}/vm/pause`,
	/** One of the few account-key operations on the chat's own VM (see vmOpRequest). */
	op: `${TURN_BOX_API_PREFIX}/vm/op`,
	/** Delete the turn's scoped identity now (turn end, Stop). */
	release: `${TURN_BOX_API_PREFIX}/vm/release`,
} as const;

export const TURN_BOX_VM_PREFIX = `${TURN_BOX_API_PREFIX}/vm/`;

const vmId = z.string().min(1).max(256);

export const vmEnsureRequest = z
	.object({
		/** The VM the box holds a token for now; with `token: null` answered when it is still the chat's. */
		knownVm: vmId.optional(),
		/** Mint a new identity even if the turn holds one (the box lost its token). */
		remint: z.boolean().optional(),
	})
	.strict();
export type VmEnsureRequest = z.infer<typeof vmEnsureRequest>;

/** The only credential-shaped thing a box ever receives, and only for its own VM and Linux user. */
export const vmEnsureResponse = z
	.object({
		vm: vmId,
		/** Null: the identity the box already holds is still the turn's, for this VM. */
		grant: z
			.object({
				token: z.string().min(1),
				linuxUser: z.string().min(1).max(64),
				/** Commands' output is redacted on the VM (vm-secret-redaction.ts). */
				redactOnVm: z.boolean(),
			})
			.strict()
			.nullable(),
	})
	.strict();
export type VmEnsureResponse = z.infer<typeof vmEnsureResponse>;

export const vmPauseRequest = z
	.object({
		vm: vmId,
		/** The box's tool calls running now (the edge cannot see them). */
		toolsRunning: z.number().int().min(0).max(1000),
		/** Epoch ms since nothing of the turn used the VM. */
		quietSince: z.number().int().positive(),
	})
	.strict();
export const vmPauseResponse = z
	.object({ result: z.enum(["paused", "skipped", "overtaken"]) })
	.strict();

/** Account-key operations on the chat's own VM; anything else is refused. */
export const vmOpRequest = z.discriminatedUnion("op", [
	z.object({ op: z.literal("keepAwakeForBackground"), vm: vmId }).strict(),
	z.object({ op: z.literal("settleIdleTimeout"), vm: vmId }).strict(),
	z
		.object({
			op: z.literal("applyNetworkPolicy"),
			vm: vmId,
			policy: vmNetworkPolicy,
		})
		.strict(),
	z
		.object({
			op: z.literal("snapshotEnvironment"),
			vm: vmId,
			slug: z.string().min(1).max(128),
			sizeId: machineSizeId.optional(),
		})
		.strict(),
]);
export type VmOpRequest = z.infer<typeof vmOpRequest>;
export const vmOpResponse = z
	.object({ ok: z.literal(true), snapshotId: z.string().optional() })
	.strict();

export type VmRefusal =
	| "unauthorized"
	| "forbidden"
	| "lease-lost"
	| "cancelled"
	| "bad-request"
	| "secrets"
	| "admission"
	| "unavailable"
	| "wrong-vm";

/** Error bodies: a code and, for admission, why and the user-facing text. */
export type VmErrorBody = {
	readonly error: VmRefusal;
	readonly reason?: string;
	readonly message?: string;
};
