import {
	type IncomingAttachment,
	MESSAGE_ATTACHMENT_LIMITS,
} from "#/domain/message-attachment";

/** The first limit a selection breaks, phrased for the composer, or null. */
export function attachmentLimitError(files: readonly File[]) {
	if (files.length > MESSAGE_ATTACHMENT_LIMITS.files)
		return `Attach at most ${MESSAGE_ATTACHMENT_LIMITS.files} files.`;
	const large = files.find(
		(file) => file.size > MESSAGE_ATTACHMENT_LIMITS.fileBytes,
	);
	if (large) return `${large.name} is larger than 10 MB.`;
	if (
		files.reduce((total, file) => total + file.size, 0) >
		MESSAGE_ATTACHMENT_LIMITS.totalBytes
	)
		return "Attached files exceed 20 MB in total.";
	return null;
}

function base64(file: File) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.readAsDataURL(file);
	});
}

export async function encodeAttachments(
	files: readonly File[],
): Promise<IncomingAttachment[]> {
	const error = attachmentLimitError(files);
	if (error) throw new Error(error);
	return Promise.all(
		files.map(async (file) => ({
			name: file.name,
			mediaType: file.type,
			base64: await base64(file),
		})),
	);
}
