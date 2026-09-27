import { posixShellCommand } from "#/domain/posix-command";

// The guest returns bounded data, never a public VM URL or executable HTML.
const READ_PREVIEW = `
import os, sys, json, base64, subprocess
root, requested, revision = sys.argv[1:]
root = os.path.realpath(root)
limit = 5 * 1024 * 1024
def fail(reason):
    print(json.dumps({"kind": "unavailable", "reason": reason}))
    sys.exit(0)
try:
    path = os.path.normpath(requested)
    if not os.path.isabs(path):
        prefix = os.path.basename(root) + os.sep
        if path.startswith(prefix) and not os.path.exists(os.path.join(root, path)):
            path = path[len(prefix):]
        path = os.path.join(root, path)
    if os.path.commonpath([root, os.path.realpath(path)]) != root:
        fail("This path is outside the checkout.")
    relative = os.path.relpath(path, root)
    if relative == '.' or '.git' in relative.split(os.sep) or '.git' in os.path.relpath(os.path.realpath(path), root).split(os.sep):
        fail("This file cannot be previewed.")
    if revision == 'head':
        obj = 'HEAD:' + relative
        size = subprocess.run(['git', '-C', root, 'cat-file', '-s', obj], capture_output=True, timeout=10)
        if size.returncode != 0: fail("File does not exist in HEAD.")
        if int(size.stdout) > limit: fail("Preview is limited to files under 5 MB.")
        result = subprocess.run(['git', '-C', root, 'cat-file', 'blob', obj], capture_output=True, timeout=10)
        if result.returncode != 0: fail("Could not read this version.")
        data = result.stdout
    else:
        if not os.path.isfile(path): fail("File does not exist in the working tree.")
        with open(path, 'rb') as source: data = source.read(limit + 1)
    if len(data) > limit: fail("Preview is limited to files under 5 MB.")
    ext = os.path.splitext(path)[1].lower()
    mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.avif':'image/avif'}.get(ext)
    if mime:
        print(json.dumps({"kind":"image", "dataUrl":"data:" + mime + ";base64," + base64.b64encode(data).decode('ascii')}))
    else:
        if len(data) > 200000: fail("Text preview is limited to 200 KB.")
        text = data.decode('utf-8')
        if '\\x00' in text: fail("This file is not text.")
        print(json.dumps({"kind":"text", "text":text}))
except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
    fail("Could not read this file.")
`;

export function filePreviewCommand(
	root: string,
	path: string,
	revision: "head" | "working",
) {
	return posixShellCommand([
		"python3",
		"-c",
		READ_PREVIEW,
		root,
		path,
		revision,
	]);
}
