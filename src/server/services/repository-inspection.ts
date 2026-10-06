import { posixShellCommand } from "#/domain/posix-command";
import { repositoryToolPath } from "./repository-tool-path";

const INSPECT = `import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
scope = sys.argv[2]
if not (root / scope).resolve().is_relative_to(root):
    raise ValueError('Inspection scope escaped repository')
git = ['git', '--literal-pathspecs', '-C', str(root)]
for arguments in (['status', '--short', '--untracked-files=all'], ['diff', '--no-ext-diff', '--no-textconv'], ['diff', '--cached', '--no-ext-diff', '--no-textconv']):
    subprocess.run(git + arguments + ['--', scope], check=True, timeout=20)
files = subprocess.check_output(git + ['ls-files', '--others', '--exclude-standard', '-z', '--', scope], timeout=20).decode().split('\\0')
for filename in files:
    if not filename: continue
    path = root / filename
    if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
        print('Untracked path not read (symlink or non-regular file): ' + filename, flush=True)
        continue
    result = subprocess.run(git + ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', filename], timeout=20)
    if result.returncode not in (0, 1):
        raise RuntimeError('Untracked file diff failed')`;

/** Git's no-index diff includes new files without staging, invoking text converters, or following symlinks. */
export function inspectRepositoryChangesCommand(directory: string, path = ".") {
	return posixShellCommand([
		"python3",
		"-c",
		INSPECT,
		directory,
		repositoryToolPath.parse(path),
	]);
}
