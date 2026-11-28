import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
	filePreviewKind,
	type WorkspaceFilePreview,
} from "#/domain/file-preview";
import { markdownImageSource } from "#/domain/markdown-image";
import { AgentMarkdown } from "../sessions/agent-markdown";
import { readWorkspacePreviewFn } from "./explorer.fn";
import "./file-preview.css";

export function PreviewModeSwitch({
	mode,
	onChange,
}: {
	mode: "preview" | "code";
	onChange: (mode: "preview" | "code") => void;
}) {
	return (
		<fieldset className="file-preview-switch" aria-label="File display">
			{(["preview", "code"] as const).map((value) => (
				<button
					key={value}
					type="button"
					aria-pressed={mode === value}
					onClick={() => onChange(value)}
				>
					{value === "preview" ? "Preview" : "Code"}
				</button>
			))}
		</fieldset>
	);
}

function PreviewImage({ src, path }: { src: string; path: string }) {
	const [failed, setFailed] = useState(false);
	return failed ? (
		<p className="diff-preview-empty">Image could not be displayed.</p>
	) : (
		<div className="file-image-preview">
			<img src={src} alt={path} onError={() => setFailed(true)} />
		</div>
	);
}

type ImageScope = { projectId?: string; sessionId?: string };

type MarkdownImageProps = {
	src: string;
	alt?: string;
	width?: string | number;
	height?: string | number;
};

function MarkdownImageTag({
	url,
	image,
}: {
	url: string;
	image: MarkdownImageProps;
}) {
	return (
		<img
			src={url}
			alt={image.alt ?? ""}
			width={image.width}
			height={image.height}
			loading="lazy"
			referrerPolicy="no-referrer"
		/>
	);
}

function WorkspaceMarkdownImage({
	path,
	scope,
	image,
}: {
	path: string;
	scope: ImageScope;
	image: MarkdownImageProps;
}) {
	const read = useServerFn(readWorkspacePreviewFn);
	const file = useQuery({
		queryKey: ["workspace-image", scope.projectId, scope.sessionId, path],
		queryFn: () => read({ data: { ...scope, path } }),
		enabled: Boolean(scope.projectId && scope.sessionId),
	});
	return file.data?.kind === "image" ? (
		<MarkdownImageTag url={file.data.dataUrl} image={image} />
	) : (
		<span>{image.alt || "Image"}</span>
	);
}

function MarkdownImage({
	markdownPath,
	scope,
	image,
}: {
	markdownPath: string;
	scope: ImageScope;
	image: MarkdownImageProps;
}) {
	const source = markdownImageSource(markdownPath, image.src);
	if (source?.kind === "external")
		return <MarkdownImageTag url={source.url} image={image} />;
	if (source?.kind === "workspace" && scope.projectId && scope.sessionId)
		return (
			<WorkspaceMarkdownImage path={source.path} scope={scope} image={image} />
		);
	return <span>{image.alt || "Image"}</span>;
}

export function FilePreview({
	path,
	content,
	projectId,
	sessionId,
}: {
	path: string;
	content: WorkspaceFilePreview;
} & ImageScope) {
	if (content.kind === "unavailable")
		return <p className="diff-preview-empty">{content.reason}</p>;
	if (content.kind === "image")
		return (
			<PreviewImage key={content.dataUrl} src={content.dataUrl} path={path} />
		);
	if (filePreviewKind(path) === "svg")
		return (
			<PreviewImage
				key={content.text}
				src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.text)}`}
				path={path}
			/>
		);
	return (
		<div className="file-markdown-preview">
			<AgentMarkdown
				text={content.text}
				renderImage={(image) => (
					<MarkdownImage
						markdownPath={path}
						scope={{ projectId, sessionId }}
						image={image}
					/>
				)}
			/>
		</div>
	);
}

export function WorkspaceImagePreview({
	path,
	projectId,
	sessionId,
}: {
	path: string;
	projectId?: string;
	sessionId?: string;
}) {
	const read = useServerFn(readWorkspacePreviewFn);
	const source = useQuery({
		queryKey: ["workspace-image", projectId, sessionId, path],
		queryFn: () => read({ data: { projectId, sessionId, path } }),
		enabled: Boolean(projectId && sessionId),
	});
	return (
		<FilePreview
			path={path}
			content={
				source.data ?? {
					kind: "unavailable",
					reason: source.isFetching
						? "Opening image…"
						: "Image preview unavailable.",
				}
			}
		/>
	);
}

export function WorkspaceDiffPreview({
	path,
	projectId,
	sessionId,
}: {
	path: string;
	projectId?: string;
	sessionId?: string;
}) {
	const read = useServerFn(readWorkspacePreviewFn);
	const versions = useQuery({
		queryKey: ["workspace-preview-versions", projectId, sessionId, path],
		queryFn: () =>
			Promise.all(
				(["head", "working"] as const).map((revision) =>
					read({ data: { projectId, sessionId, path, revision } }),
				),
			),
		enabled: Boolean(projectId && sessionId),
		staleTime: 0,
	});
	return (
		<div className="file-preview-comparison">
			<p className="file-preview-note">
				Current checkout comparison, not a historical turn snapshot.
			</p>
			{["Before · HEAD", "After · Working tree"].map((label, index) => (
				<section key={label}>
					<h4>{label}</h4>
					<FilePreview
						path={path}
						projectId={projectId}
						sessionId={sessionId}
						content={
							versions.data?.[index] ?? {
								kind: "unavailable",
								reason: versions.isFetching
									? "Opening preview…"
									: "Preview unavailable.",
							}
						}
					/>
				</section>
			))}
		</div>
	);
}
