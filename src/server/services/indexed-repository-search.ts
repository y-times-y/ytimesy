const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function repositorySearchCommand(input: {
	cwd: string;
	query: string;
	literal: boolean;
	path: string;
	wordBoundary?: boolean;
	useIndex?: boolean;
}) {
	if (!input.useIndex)
		return `git --literal-pathspecs -C ${quote(input.cwd)} grep --untracked --exclude-standard -n -I ${input.literal ? "-F " : ""}${input.wordBoundary ? "-w " : ""}-e ${quote(input.query)} -- ${quote(input.path)}`;
	return `python3 -c ${quote(INDEXED_SEARCH_SOURCE)} ${quote(JSON.stringify(input))}`;
}

// The index only selects candidates. Git owns matching, exclusions, and output.
export const INDEXED_SEARCH_SOURCE = String.raw`
import hashlib, json, os, re, sqlite3, stat, subprocess, sys, tempfile, time

request = json.loads(sys.argv[1])
MIN_INDEX_BYTES = 16 * 1024 * 1024
root = os.path.realpath(request['cwd'])
query = request['query']
scope = request['path']
git = ['git', '--literal-pathspecs', '-C', root]
grep = git + ['grep', '--untracked', '--exclude-standard', '-n', '-I']
if request['literal']:
    grep += ['-F']
if request.get('wordBoundary', False):
    grep += ['-w']
grep += ['-e', query, '--']

def fallback():
    return subprocess.call(grep + [scope])

def inventory():
    paths = subprocess.check_output(git + ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', scope])
    result = {}
    for raw in paths.split(b'\0'):
        if not raw:
            continue
        path = os.fsdecode(raw)
        absolute = os.path.join(root, path)
        try:
            info = os.lstat(absolute)
            if not stat.S_ISREG(info.st_mode):
                # Symlinks and special files never become negative index evidence.
                result[path] = None
            else:
                result[path] = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        except FileNotFoundError:
            continue
    return result

def private_cache():
    identity = hashlib.sha256(os.fsencode(root)).hexdigest()
    directory = os.path.join(tempfile.gettempdir(), 'ytimesy-search-' + str(os.getuid()) + '-' + identity)
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Unsafe index directory')
    database = os.path.join(directory, 'index.sqlite')
    descriptor = os.open(database, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Unsafe index database')
    finally:
        os.close(descriptor)
    return database

def indexed():
    # FTS5 trigram cannot narrow short terms. Non-ASCII and multiline queries
    # retain Git semantics without depending on tokenizer Unicode behavior.
    # Plain identifiers have the same mandatory text in Git's basic regex mode.
    # Do not infer required substrings from actual regex syntax.
    plain_identifier = re.fullmatch(r'[A-Za-z0-9_]+', query) is not None
    if (not request['literal'] and not plain_identifier) or len(query) < 3 or not query.isascii() or '\n' in query or '\r' in query:
        return fallback()
    before = inventory()
    corpus_bytes = sum(item[2] for item in before.values() if item)
    # Git's native scan wins on small corpora; avoid SQLite refresh/query overhead.
    if len(before) > 10000 or corpus_bytes < MIN_INDEX_BYTES or corpus_bytes > 64 * 1024 * 1024:
        return fallback()
    deadline = time.monotonic() + 8
    connection = sqlite3.connect(private_cache(), timeout=0.2)
    try:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute('PRAGMA user_version').fetchone()[0] != 2:
            connection.execute('DROP TABLE IF EXISTS contents')
            connection.execute('DROP TABLE IF EXISTS files')
            connection.execute('PRAGMA user_version = 2')
        connection.execute('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, searchable INTEGER NOT NULL)')
        connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS contents USING fts5(path UNINDEXED, body, tokenize='trigram', detail=none, columnsize=0)")
        cached = {path: (fingerprint, rowid) for path, fingerprint, rowid in connection.execute('SELECT path, fingerprint, rowid FROM files')}
        if scope == '.':
            for removed in cached.keys() - before.keys():
                connection.execute('DELETE FROM contents WHERE rowid = ?', (cached[removed][1],))
                connection.execute('DELETE FROM files WHERE path = ?', (removed,))
            cached = {path: value for path, value in cached.items() if path in before}
        if len(cached.keys() | before.keys()) > 20000:
            raise ValueError('Index file budget exceeded')
        for path, fingerprint in before.items():
            if time.monotonic() > deadline:
                raise TimeoutError('Index refresh exceeded budget')
            encoded = json.dumps(fingerprint)
            if cached.get(path, (None, None))[0] == encoded:
                continue
            body = None
            if fingerprint and fingerprint[2] <= 1024 * 1024:
                try:
                    with open(os.path.join(root, path), 'rb') as source:
                        content = source.read(1024 * 1024 + 1)
                    if len(content) <= 1024 * 1024 and b'\0' not in content:
                        body = content.decode('utf-8')
                except (OSError, UnicodeError):
                    pass
            if path in cached:
                connection.execute('DELETE FROM contents WHERE rowid = ?', (cached[path][1],))
            connection.execute('INSERT INTO files VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint, searchable=excluded.searchable', (path, encoded, int(body is not None)))
            if body is not None:
                rowid = connection.execute('SELECT rowid FROM files WHERE path = ?', (path,)).fetchone()[0]
                connection.execute('INSERT INTO contents(rowid, path, body) VALUES (?, ?, ?)', (rowid, path, body))
        # A scoped refresh must not retire entries outside the requested scope.
        # Positionless trigrams reduce storage. One mandatory trigram is a
        # superset of exact matches; Git still decides the final result.
        expression = '"' + query[:3].replace('"', '""') + '"'
        candidates = set(row[0] for row in connection.execute('SELECT path FROM contents WHERE contents MATCH ?', (expression,)))
        candidates.update(row[0] for row in connection.execute('SELECT path FROM files WHERE searchable = 0'))
        candidates.intersection_update(before)
        connection.commit()
    finally:
        connection.close()
    if inventory() != before:
        return fallback()
    ordered = sorted(candidates, key=os.fsencode)
    # Avoid argv limits and multi-command results that would alter ordering.
    if sum(len(os.fsencode(path)) + 1 for path in ordered) > 64000:
        return fallback()
    return subprocess.call(grep + ordered) if ordered else 1

try:
    status = indexed()
except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError, TimeoutError, UnicodeError):
    status = fallback()
sys.exit(status)
`;
