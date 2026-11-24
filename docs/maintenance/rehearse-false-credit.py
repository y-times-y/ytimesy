"""Run `python3 rehearse-false-credit.py NEW_DIRECTORY` to produce local bundles only."""

from pathlib import Path
import os
import sys
import re
import subprocess as sp


def git(*args, data=None):
    return sp.check_output(['git', '--no-replace-objects', '-C', 'repo.git', *args], input=data)


def parse_commit(sha):
    headers, message = git('cat-file', 'commit', sha).split(b'\n\n', 1)
    return re.split(rb'\n(?! )', headers), message


def header_key(header):
    return header.split(b' ', 1)[0]


# Raw plumbing retains byte-exact messages and unknown headers. Export/import
# would require separately guarding against normalization and signature loss.
targets = {
    '871a50eee64d5d62f1f1a76eb25e0c2a583404cd',
    '17e20f9fa382b8a1ebc3cb236fa97d96e834a228',
    'd9e85b47b6bb7de15cb63efd349088f2e8e032df',
    'e4419f0e910160e1610fafa64c66a66742ebb2b6',
    'b180617bba3ab62f13efd7910703880959311ab2',
}
if len(sys.argv) != 2 or not __debug__:
    sys.exit(__doc__)
output = Path(sys.argv[1]).resolve()
output.mkdir(mode=0o700)
# Do not inherit a caller's Git worktree, object directory, or index override.
for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
            'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'):
    os.environ.pop(key, None)
os.chdir(output)
sp.run(['git', 'init', '--bare', '-q', 'repo.git'], check=True)
git('fetch', 'https://github.com/y-times-y/ytimesy.git',
    '+refs/heads/*:refs/audit/heads/*', '+refs/pull/*:refs/audit/pull/*',
    '+refs/tags/*:refs/audit/tags/*')
snapshot = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/audit/')
Path('snapshot').write_bytes(snapshot)
refs = dict(line.split() for line in snapshot.decode().splitlines())
if any(ref.startswith('refs/audit/tags/') for ref in refs):
    sys.exit('Unexpected tags: audit tag targets and signatures before preparing another candidate.')
order = git('rev-list', '--topo-order', '--reverse', '--stdin', data=('\n'.join(refs.values())+'\n').encode()).decode().splitlines()
assert targets <= set(order), 'One or more audited commits are missing'
canonical = b'ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>'
old_identity = b'ytimesy <ytimesy@users.noreply.github.com>'
trailers = b'Co-authored-by: ' + canonical
# Only these GitHub-generated, read-only test merges are allowed to lose
# signatures in the local analysis. No branch history may lose a signature.
synthetic_merges = {
    '208fe6fa86ee3c37281391e0874b9a7139a12e60',
    'c1715cd84ba1034d98b216ae3f8952022121e94b',
    '19181cff45073ad0c380985a15c602cda12f57bd',
}
mapped, unsigned = {}, set()
for sha in order:
    headers, message = parse_commit(sha)
    identities = [h for h in headers if header_key(h) in (b'author', b'committer')]
    matches = [h for h in identities if b' <ytimesy@users.noreply.github.com> ' in h.lower()]
    assert len(matches) == (2 if sha in targets else 0), sha
    assert not re.search(rb'(?i)(?:\b120704583\+)?ytimesy@users\.noreply\.github\.com', message), sha
    updated = []
    for h in headers:
        key, _, value = h.partition(b' ')
        if key == b'parent':
            value = mapped[value.decode()].encode()
        if sha in targets and key in (b'author', b'committer'):
            assert value.startswith(old_identity + b' ') and trailers in message.splitlines(), sha
            value = canonical + value[len(old_identity):]
        updated.append(key + b' ' + value)
    if updated == headers:
        mapped[sha] = sha
        continue
    assert not any(header_key(h) == b'mergetag' for h in headers), sha
    if any(header_key(h).startswith(b'gpgsig') for h in headers):
        assert sha in synthetic_merges, f'Unexpected signed descendant: {sha}'
        unsigned.add(sha)
        updated = [h for h in updated if not header_key(h).startswith(b'gpgsig')]
    raw = b'\n'.join(updated) + b'\n\n' + message
    new = git('hash-object', '-t', 'commit', '-w', '--stdin', data=raw).strip().decode()
    assert parse_commit(new) == (updated, message)
    mapped[sha] = new

assert len(set(mapped.values())) == len(order)
with Path('commit-map.tsv').open('w') as out:
    for old in order:
        if old != mapped[old]:
            print(old, mapped[old], 'target' if old in targets else 'descendant', 'signature removed' if old in unsigned else '-', sep='\t', file=out)
with Path('ref-map.tsv').open('w') as out:
    for ref, old in refs.items():
        new = mapped[old]
        reachable = set(git('rev-list', old).decode().splitlines())
        changes = [s for s in reachable if mapped[s] != s]
        assert not (ref.startswith('refs/audit/heads/') and unsigned & reachable), ref
        if changes:
            candidate = ref.replace('refs/audit/', 'refs/rehearsal/', 1)
            git('update-ref', candidate, new)
            print(ref, old, new, len(changes), len(unsigned & reachable), sep='\t', file=out)
git('fsck', '--full', '--no-dangling')
for name, bundle_refs in (
    ('original.bundle', refs),
    ('candidate.bundle', git('for-each-ref', '--format=%(refname)', 'refs/rehearsal/').decode().splitlines()),
):
    git('bundle', 'create', str(output / name), *bundle_refs)
    git('bundle', 'verify', str(output / name))
print(f'{len(order)} inspected, {sum(k != v for k,v in mapped.items())} changed, {len(unsigned)} signatures removed')
print(f'Local bundles and SHA maps: {output}')
