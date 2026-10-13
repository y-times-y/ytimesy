import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { GitTransferHost } from "../github/git-broker";

/** Export only Git work and per-chat native state, never auth files or dependencies. */
function exportCheckpointScript(
	repositories: readonly string[],
	nativeRoot: string | null,
	output: string,
) {
	return `python3 -c ${quote(`import pathlib,subprocess,json,base64,sqlite3,tempfile,os
repos=json.loads(${JSON.stringify(JSON.stringify(repositories))})
root=${nativeRoot === null ? "None" : JSON.stringify(nativeRoot)}
def git(path,*args):
 return subprocess.check_output(['git','-C',path,*args])
def enc(data): return base64.b64encode(data).decode()
result={'repositories':[],'native':{}}
for path in repos:
 with tempfile.TemporaryDirectory() as temp:
  bundle=temp+'/repo.bundle'
  git(path,'bundle','create',bundle,'HEAD','--all')
  files={}
  for name in git(path,'ls-files','--others','--exclude-standard','-z').decode().split('\\0'):
   if not name: continue
   file=pathlib.Path(path)/name
   if file.is_symlink(): raise RuntimeError('Untracked symlink must be tracked before checkpointing')
   files[name]=enc(file.read_bytes())
  branch=git(path,'symbolic-ref','--short','HEAD').decode().strip()
  shallow=pathlib.Path(git(path,'rev-parse','--git-path','shallow').decode().strip())
  if not shallow.is_absolute(): shallow=pathlib.Path(path)/shallow
  result['repositories'].append({'path':path,'branch':branch,'bundle':enc(pathlib.Path(bundle).read_bytes()),'shallow':shallow.read_text() if shallow.exists() else '', 'work':enc(git(path,'diff','--binary','HEAD')),'index':enc(git(path,'diff','--cached','--binary','HEAD')),'files':files})
if root:
 native=pathlib.Path(root)
 for folder in ['home/.codex/sessions','home/.codex/archived_sessions']:
  for file in (native/folder).rglob('*.jsonl'):
   if file.is_symlink(): raise RuntimeError('Invalid native history')
   result['native'][str(file.relative_to(native))]=enc(file.read_bytes())
 for file in (native/'home/.codex').glob('state_*.sqlite'):
  if file.is_symlink(): raise RuntimeError('Invalid native state')
  with tempfile.TemporaryDirectory() as temp:
   destination=sqlite3.connect(temp+'/state.sqlite')
   source=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
   source.backup(destination);destination.close();source.close()
   result['native'][str(file.relative_to(native))]=enc(pathlib.Path(temp+'/state.sqlite').read_bytes())
 for name in ['ytimesy-codex-thread-state.json']:
  file=native/name
  if file.exists(): result['native'][name]=enc(file.read_bytes())
payload=json.dumps(result)
if len(payload)>20000000: raise RuntimeError('Checkpoint exceeds safety limit')
pathlib.Path(${JSON.stringify(output)}).write_text(payload)
os.chmod(${JSON.stringify(output)},0o600)`)} `;
}

export async function exportGuestCheckpoint(
	host: GitTransferHost,
	repositories: readonly string[],
	nativeRoot: string | null,
	output: string,
) {
	if (!host.readTextFile)
		throw new Error("Checkpoint file transfer unavailable.");
	try {
		const result = await host.exec(
			exportCheckpointScript(repositories, nativeRoot, output),
			120_000,
		);
		if (result.exitCode !== 0)
			throw new Error(
				"Could not capture checkpoint; the previous checkpoint remains available.",
			);
		const text = await host.readTextFile(output);
		if (!text) throw new Error("Checkpoint capture returned no data.");
		return text;
	} finally {
		await host.exec(`rm -f ${quote(output)}`, 10_000).catch(() => undefined);
	}
}

export async function restoreGuestCheckpoint(
	host: GitTransferHost,
	payload: string,
	paths: readonly string[],
	nativeRoot: string | null,
	transfer: string,
) {
	await host.writeTextFile(transfer, payload);
	const script = `import pathlib,json,base64,subprocess,os,tempfile,shutil,re
data=json.loads(pathlib.Path(${JSON.stringify(transfer)}).read_text())
allowed=json.loads(${JSON.stringify(JSON.stringify(paths))})
root=${nativeRoot === null ? "None" : JSON.stringify(nativeRoot)}
def safe_parents(file,base):
 if file.is_symlink(): raise RuntimeError('Symlink at restore destination')
 current=base
 if current.is_symlink(): raise RuntimeError('Symlink in restore root')
 for part in file.relative_to(base).parts[:-1]:
  current=current/part
  if current.is_symlink(): raise RuntimeError('Symlink in restore path')
def dec(text): return base64.b64decode(text,validate=True)
def git(path,*args,input=None): return subprocess.run(['git','-C',str(path),'-c','core.hooksPath=/dev/null',*args],input=input,check=True,stdout=subprocess.DEVNULL)
for repo in data['repositories']:
 if repo['path'] not in allowed: raise RuntimeError('Unexpected repository path')
 for name in repo['files']:
  p=pathlib.PurePosixPath(name)
  if p.is_absolute() or '..' in p.parts or '.git' in p.parts: raise RuntimeError('Invalid untracked path')
 for field in ['bundle','work','index']: dec(repo[field])
 if any(not re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}',line) for line in repo.get('shallow','').splitlines()): raise RuntimeError('Invalid shallow boundary')
 subprocess.run(['git','check-ref-format','--branch',repo['branch']],check=True,stdout=subprocess.DEVNULL)
if data['native'] and not root: raise RuntimeError('Unexpected native history')
for name in data['native']:
 p=pathlib.PurePosixPath(name)
 valid=name=='ytimesy-codex-thread-state.json' or (name.startswith(('home/.codex/sessions/','home/.codex/archived_sessions/')) and name.endswith('.jsonl')) or (p.parent==pathlib.PurePosixPath('home/.codex') and p.name.startswith('state_') and p.name.endswith('.sqlite'))
 if p.is_absolute() or '..' in p.parts or not valid: raise RuntimeError('Invalid native history path')
 dec(data['native'][name])
for repo in data['repositories']:
 target=pathlib.Path(repo['path'])
 with tempfile.TemporaryDirectory(dir=str(target.parent),prefix='.ytimesy-restore-') as tmp:
  stage=pathlib.Path(tmp)/'checkout';stage.mkdir()
  bundle=pathlib.Path(tmp)/'repo.bundle';bundle.write_bytes(dec(repo['bundle']))
  git(stage,'init')
  if repo.get('shallow'): (stage/'.git/shallow').write_text(repo['shallow'])
  git(stage,'bundle','verify',str(bundle));git(stage,'fetch',str(bundle),'HEAD');git(stage,'checkout','-b',repo['branch'],'FETCH_HEAD')
  if any(line.split(' ',1)[-1].startswith('refs/ytimesy/') for line in subprocess.check_output(['git','bundle','list-heads',str(bundle)],text=True).splitlines()):
   git(stage,'fetch',str(bundle),'refs/ytimesy/*:refs/ytimesy/*')
  if repo['work']: git(stage,'apply','--binary',input=dec(repo['work']))
  if repo['index']: git(stage,'apply','--cached','--binary',input=dec(repo['index']))
  for name,content in repo['files'].items():
   dest=stage/name
   safe_parents(dest,stage)
   dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(dec(content))
  if target.exists():
   original=pathlib.Path(tmp)/'template';target.rename(original)
  stage.rename(target)
if root:
 for name,content in data['native'].items():
  file=pathlib.Path(root)/name
  safe_parents(file,pathlib.Path(root))
  file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(dec(content));os.chmod(file,0o600)
print('restored')`;
	try {
		const result = await host.exec(`python3 -c ${quote(script)}`, 120_000);
		if (result.exitCode !== 0 || !result.stdout.includes("restored"))
			throw new Error("Checkpoint restore failed; no agent turn was started.");
	} finally {
		await host.exec(`rm -f ${quote(transfer)}`, 10_000).catch(() => undefined);
	}
}
