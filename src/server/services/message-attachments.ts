import { randomUUID } from "node:crypto";
import { detectMediaType } from "@ai-sdk/provider-utils";
import type { WorkspaceId } from "#/domain/ids";
import {
	AGENT_ATTACHMENT_DIRECTORY,
	attachmentPath,
	base64ByteLength,
	declaredMediaType,
	type IncomingAttachment,
	type MessageAttachment,
	safeAttachmentName,
} from "#/domain/message-attachment";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import {
	downloadMessageAttachment,
	uploadMessageAttachment,
} from "../adapters/checkpoints/storage";
import type { WorkspaceMachines } from "./workspace-machines";

/** Store each file privately before the message is queued; the item keeps metadata only. */
export async function storeMessageAttachments(
	userId: string,
	sessionId: string,
	files: readonly IncomingAttachment[] | undefined,
): Promise<MessageAttachment[]> {
	if (!files?.length) return [];
	const names = new Set<string>();
	return Promise.all(
		files.map(async (file) => {
			const id = randomUUID();
			let name = safeAttachmentName(file.name);
			// Two files with one name stay distinct; each also has its own directory.
			for (let copy = 2; names.has(name); copy++)
				name = `${copy}-${safeAttachmentName(file.name)}`;
			names.add(name);
			const detected = detectMediaType({
				data: file.base64,
				topLevelType: "image",
			});
			await uploadMessageAttachment(userId, sessionId, id, file.base64);
			return {
				id,
				name,
				mediaType: detected ?? declaredMediaType(file.mediaType),
				size: base64ByteLength(file.base64),
			};
		}),
	);
}

export function sessionAttachments(items: readonly SessionItem[]) {
	return items.flatMap((item) =>
		item.kind === "userMessage" ? (item.attachments ?? []) : [],
	);
}

/** Write any attachment the machine lacks; a rebuilt VM gets every file back. */
export async function materializeMessageAttachments(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	userId: string,
	sessionId: string,
	attachments: readonly MessageAttachment[],
) {
	if (!attachments.length) return;
	const listed = await machines.exec(
		vm,
		`mkdir -p ${quote(AGENT_ATTACHMENT_DIRECTORY)} && chmod 700 ${quote(AGENT_ATTACHMENT_DIRECTORY)} && for f in ${attachments.map((attachment) => quote(attachmentPath(attachment))).join(" ")}; do [ -f "$f" ] && printf '%s\\n' "$f"; done; true`,
		15_000,
	);
	if (listed.exitCode)
		throw new Error("Could not prepare attached files in the workspace.");
	const present = new Set(listed.stdout.split("\n").filter(Boolean));
	for (const attachment of attachments) {
		const path = attachmentPath(attachment);
		if (present.has(path)) continue;
		const base64 = await downloadMessageAttachment(
			userId,
			sessionId,
			attachment.id,
		);
		const staged = `${AGENT_ATTACHMENT_DIRECTORY}/${attachment.id}.b64`;
		await machines.writeTextFile(vm, staged, base64);
		const written = await machines.exec(
			vm,
			`mkdir -p ${quote(`${AGENT_ATTACHMENT_DIRECTORY}/${attachment.id}`)} && base64 -d < ${quote(staged)} > ${quote(path)} && rm -f ${quote(staged)}`,
			30_000,
		);
		if (written.exitCode)
			throw new Error(`Could not write the attached file ${attachment.name}.`);
	}
}
