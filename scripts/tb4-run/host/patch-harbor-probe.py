"""Run-doc amendment 2026-10-28: raise Harbor 0.24.0's Docker egress-capability probe timeout
from 30 s to 300 s (a busy host timed the probe out and Harbor then rejected the offline
verifier). Enforcement (the deny-all sidecar) is unchanged. Idempotent; keeps the original.
Run with Harbor's own Python as the trial user."""
import re,shutil,hashlib,sys
F='/home/ubuntu/.local/share/uv/tools/harbor/lib/python3.12/site-packages/harbor/environments/docker/docker.py'
s=open(F).read(); before=hashlib.sha256(s.encode()).hexdigest()[:16]
start=s.index('def _egress_control_kernel_support'); end=s.index('return result.returncode == 0',start)
body=s[start:end]
if 'timeout=300,' in body: print('already patched',before); sys.exit(0)
assert body.count('timeout=30,')==1
shutil.copy(F,F+'.orig-0.24.0')
s=s[:start]+body.replace('timeout=30,','timeout=300,  # tb4-astra 2026-10-28: was 30 s; a busy host timed out the probe')+s[end:]
open(F,'w').write(s)
print('patched',before,'->',hashlib.sha256(s.encode()).hexdigest()[:16])
