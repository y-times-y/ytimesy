import { posixShellQuoted as quote } from "#/domain/posix-command";

/** Python and same-directory staging, as in edit-scripts.ts, but fed in chunks. */
const PREPARE_FILE_UPLOAD = `import json, os, stat, sys, tempfile
path = os.path.realpath(sys.argv[1])
os.makedirs(os.path.dirname(path), exist_ok=True)
mode = stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else None
directory = tempfile.mkdtemp(prefix='.ytimesy-upload-', dir=os.path.dirname(path))
with open(os.path.join(directory, 'target.json'), 'w') as handle:
    json.dump({'path': path, 'mode': mode}, handle)`;

export const BEGIN_FILE_UPLOAD = `${PREPARE_FILE_UPLOAD}\nprint(directory)`;

const REPLACE_FILE_UPLOAD = `with open(os.path.join(folder, 'target.json')) as handle:
    target = json.load(handle)
source = os.path.join(folder, 'contents')
with open(source, 'rb') as handle:
    os.fsync(handle.fileno())
mode = target['mode']
if mode is None:
    mask = os.umask(0)
    os.umask(mask)
    mode = 0o666 & ~mask
os.chmod(source, mode)
os.replace(source, target['path'])
parent = os.open(os.path.dirname(target['path']), os.O_RDONLY)
try:
    os.fsync(parent)
finally:
    os.close(parent)`;

/** One exec for ordinary files; no extra network round trips for staging. */
export function completeFileUpload(path: string) {
	const script = `${PREPARE_FILE_UPLOAD}
folder = directory
try:
    with open(os.path.join(folder, 'contents'), 'wb') as handle:
        handle.write(sys.stdin.buffer.read())
${REPLACE_FILE_UPLOAD.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
finally:
    import shutil
    shutil.rmtree(folder)`;
	return `python3 -c ${quote(script)} ${quote(path)}`;
}

export function beginFileUpload(path: string) {
	return `python3 -c ${quote(BEGIN_FILE_UPLOAD)} ${quote(path)}`;
}

export function appendFileUpload(directory: string, first: boolean) {
	return `umask 077; cat ${first ? ">" : ">>"} ${quote(`${directory}/contents`)}`;
}

export function commitFileUpload(directory: string) {
	return `python3 -c ${quote(`import json, os, sys
folder = sys.argv[1]
${REPLACE_FILE_UPLOAD}`)} ${quote(directory)}`;
}
