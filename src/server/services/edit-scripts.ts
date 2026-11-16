/**
 * The Python of the checked file edit, shared by the file tools
 * (api-agent-file-tools.ts) and the lean surfaces' writer (lean-scripts.ts).
 * Kept apart from the tools so the lean engine bundles without them (the
 * Claude runner box runs it: claude-box-tools/).
 */

/** Characters one read, page or check returns by default (also the scripts' cap). */
export const FILE_TOOL_CHARACTERS = 32_000;

const EDIT_OPERATION_SCRIPT = `
relative = pathlib.Path(request['path'])
if relative.is_absolute() or '.git' in relative.parts:
    raise ValueError('Path must be inside the repository and outside .git')
requested = root / relative
if requested.is_symlink():
    raise ValueError('Symlink paths cannot be edited')
target = requested.resolve()
if not target.is_relative_to(root) or target == root:
    raise ValueError('Path outside repository')
if '.git' in target.relative_to(root).parts:
    raise ValueError('Resolved path must be outside .git')
if request['operation'] == 'create':
    if target.exists() or target.is_symlink():
        raise ValueError('File already exists; inspect it before editing')
    content = request['content']
    mode = 0o644
else:
    if not target.is_file() or target.is_symlink():
        raise ValueError('File is unavailable or is a symlink')
    with target.open('r', encoding='utf-8', newline='') as handle:
        existing = handle.read()
    mode = stat.S_IMODE(target.stat().st_mode)
    if request['operation'] in ('write', 'delete', 'move'):
        if hashlib.sha256(existing.encode()).hexdigest() != request['expectedSha256']:
            raise ValueError('File changed since inspection; read the latest file before patching')
        if request['operation'] == 'delete':
            if validate_only:
                return {'path': request['path']}
            target.unlink()
            return {'path': request['path'], 'deleted': True}
        content = request['content']
    else:
        old = request['old']
        if existing.count(old) != 1:
            raise ValueError('Expected text must occur exactly once; inspect the latest file')
        content = existing.replace(old, request['new'], 1)
if request['operation'] == 'move':
    destination_relative = pathlib.Path(request['newPath'])
    if destination_relative.is_absolute() or '.git' in destination_relative.parts or '..' in destination_relative.parts:
        raise ValueError('Invalid move destination')
    destination = root / destination_relative
    if destination.exists() or destination.is_symlink():
        raise ValueError('Move destination already exists')
    if not destination.parent.is_dir() or destination.parent.resolve() != destination.parent or not destination.parent.resolve().is_relative_to(root):
        raise ValueError('Move destination parent must exist inside the repository without symlinks')
    if validate_only:
        return {'path': request['path']}
    descriptor, temporary = tempfile.mkstemp(prefix='.ytimesy-move-', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='') as handle:
            handle.write(content)
        os.chmod(temporary, mode)
        os.link(temporary, destination)
        target.unlink()
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'path': request['newPath'], 'previousPath': request['path'], 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'diagnosticSource': content if len(content) <= ${FILE_TOOL_CHARACTERS} else None}
if validate_only:
    return {'path': request['path']}
target.parent.mkdir(parents=True, exist_ok=True)
if not target.parent.resolve().is_relative_to(root):
    raise ValueError('Parent directory escaped repository')
descriptor, temporary = tempfile.mkstemp(prefix='.ytimesy-edit-', dir=target.parent)
try:
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write(content)
    os.chmod(temporary, mode)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
return {'path': request['path'], 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'diagnosticSource': content if len(content) <= ${FILE_TOOL_CHARACTERS} else None}`;

/**
 * Python (needs fcntl, hashlib, os, pathlib, stat, tempfile and a resolved
 * `root`): takes the repository's edit lock and defines
 * `apply_edit(request, validate_only=False)`, one checked edit relative to
 * `root`: no absolute paths or .git, no symlinks, no escape from `root`,
 * stale-content refusal, atomic replace with the temp file always removed.
 * The lean surfaces' file writer uses the same function.
 */
export const LOCKED_APPLY_EDIT = `lock = open('/tmp/ytimesy-edit-lock-' + hashlib.sha256(str(root).encode()).hexdigest(), 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
def apply_edit(request, validate_only=False):
${EDIT_OPERATION_SCRIPT.trim()
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}`;
