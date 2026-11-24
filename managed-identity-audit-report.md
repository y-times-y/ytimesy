# Managed Git identity audit — standalone review artifact

Pinned main: `a9a8caf92ab5455df2d0f08edf3b95c4ca2cbece`. Candidate: `05d881bf6ccab9b0be400ea30426c5ff251c09df`.

Scope: `git log -255 --remotes=origin` (255 distinct reachable commits in Git’s default date traversal across local origin-tracking refs; not all history and not a count of users). The main cross-check is a separate latest-255 walk from pinned main. Candidate rows use raw author names beginning with `ytimesy`, excluding GitHub-committer rows. `GitHub` committer is the separate web-flow heuristic, not evidence of impersonation or proof of a specific GitHub UI action. Matching names and timestamps do not prove who initiated a commit; commits with identical human author/committer names are not classified by this heuristic. Remote refs can move; the exact flagged SHAs below pin the results. No commit was rewritten. Thread ownership cannot be verified from Git metadata; no SHA-to-thread mapping is asserted.

## origin

59 candidates and 7 possible web-flow commits, of 255 inspected.

### Attribution candidates

- `a9a8caf92ab5455df2d0f08edf3b95c4ca2cbece`
- `fac60fc5cdfe2850e4acdee54d8cdca94cb4afd0`
- `fda10e70404b2b098b043b33ffd3b3858d81e606`
- `a08261fbc150b192364076f77baea94033e9b164`
- `d8c91b3dda72a7d82d0a398858d8b3fcc4705189`
- `aec75c6bb245ed63b5b33af5afc2733410bb4c76`
- `b180617bba3ab62f13efd7910703880959311ab2`
- `cbb3f897383b32bad1839108e23822efc7336edf`
- `2e581df3f980ef10bb23bd562afb2de1ce80a708`
- `245847660ca02d274e5b5d1cb006394716a23e67`
- `9f53d75a3567885c04fb4b59c46247f26342b0dc`
- `e4419f0e910160e1610fafa64c66a66742ebb2b6`
- `d9e85b47b6bb7de15cb63efd349088f2e8e032df`
- `17e20f9fa382b8a1ebc3cb236fa97d96e834a228`
- `871a50eee64d5d62f1f1a76eb25e0c2a583404cd`
- `c56200546be4f8907a64811cd17bb92902d5e6ff`
- `04002d1b56c95184cb8f63eaa03fa027e5c958b6`
- `7737c132b19ee1b5772a7e7adcc23c54ae07e620`
- `0adf3eb8eb752a8a22a3d5a16636feec58a50b7c`
- `08dbbc99aef68117c09d8d6c51d7057a0d236dac`
- `f8abc126a71b86bb60771a343eaa96ed661c274f`
- `a79d25bc6fc62a3c34d78bf5b2c65bb572430766`
- `c99697c3ec720d121630a13f7263bf47a86328f9`
- `cdd8896555aff5da03ab62196075605c258c250d`
- `67c890ea4e6bab0578477c5e9dc1da2ae73a0b21`
- `95cb49697178b8080aedf6de7200e33863591974`
- `cbfd62a317cf3b3f8fabd8400f0f1e6af2bad001`
- `32cc9fbbe23aad441d89d4d5670daa345dfdba80`
- `1e2bf35a5f90927a2ed5f9977d5848d110799f3b`
- `a624b4c7a385c72b32bbeb6e7d992287718b510a`
- `f03fdb848c79a75e92c6d6facfb13121998eaae7`
- `9f72cec97f2639b6b4e3a9a04e2d26d3ac77a3a2`
- `35748571d08f65292c4b966e8bec010c77e1dcae`
- `31b450fb7eeb37848cde0980aa57adfd9b27dc12`
- `5794f7c3f9a312ab8ef085e497c4b0c2b617a331`
- `963eb348a2795196d36700cd908adcef9cb5ec2c`
- `560d6fc9eceec15e566e3fa51843a02e9b4324fc`
- `bebc658858d8cc371518d487f97056125339b13e`
- `a38033fce95323fc0312454a3c72ce90938d18f7`
- `c8fb65ea2f59ade68388d3730564b6a87b8fec69`
- `273c953f070367c6275e9cd779591dbd3162ca95`
- `9d13267f32a1c6ded6e0a3d4fb0efb789af96a3c`
- `132032964c8bc03d0dd4f9a8c4b3c620bb014844`
- `721c6d92af376c644ef4674d346e9c2e87f5f16a`
- `cd9610990bcd429196ac292395597b83b70afec8`
- `c48b63ec27017b380de0c6ab01c7f16612d3d568`
- `4dc5d1252b0c7129df412683bd93506810e2f916`
- `662f735b48d9cd403dda206ae2de60c3a8bb06b0`
- `29cb0ef382c052556864c4a96b5a4ceecfc98af3`
- `b9a3c9b0f476d036881871602a9ce9a0156cab14`
- `4baad6d73a9b4e647a28295a654ad061d000ed2d`
- `c01f6d9ab16e3105fa442ceeae72abfa91dbd3ca`
- `a0c2573965e253280595da6aa92dbcd0fe8869b5`
- `6364b6c59f3694fd88f621ad2b9c4aab46dfcd69`
- `bd0aa709bd94e56b8bacc3ab8dd0e6538f080224`
- `f09839bb2283a7d122381a477c5d0ffade755a8e`
- `4ccdb39eabde0163babaf06b5faac376867b01c1`
- `ea916ebb7ec9d3c0d58a6eb2f46a57a0c804028f`
- `99e7289091e111073a3ab835ca01ea82a5a4e3ce`

### Possible web-flow (separate)

- `9b12bc6bff33a4579da5467ec86d29a5be982449`
- `bc9210f7db279ab90b83d9b89df7e52141c31da4`
- `5ce4427a9473f87bd3478a1e8d544d3e090aa81f`
- `8d051537b84cb3b99fc6d912dfbe18c5832bd291`
- `f724e9a4959e1542078b22fa3c1b3c5adb9b0a84`
- `5f8b0d98a9cae60e84a57207ba5dc7448eb37682`
- `a2ba013ba17a4c3e3d05ccbc4260a72fad620fd5`

## main

45 candidates and 4 possible web-flow commits, of 255 inspected.

### Attribution candidates

- `a9a8caf92ab5455df2d0f08edf3b95c4ca2cbece`
- `fac60fc5cdfe2850e4acdee54d8cdca94cb4afd0`
- `fda10e70404b2b098b043b33ffd3b3858d81e606`
- `a08261fbc150b192364076f77baea94033e9b164`
- `d8c91b3dda72a7d82d0a398858d8b3fcc4705189`
- `aec75c6bb245ed63b5b33af5afc2733410bb4c76`
- `b180617bba3ab62f13efd7910703880959311ab2`
- `cbb3f897383b32bad1839108e23822efc7336edf`
- `9f53d75a3567885c04fb4b59c46247f26342b0dc`
- `e4419f0e910160e1610fafa64c66a66742ebb2b6`
- `d9e85b47b6bb7de15cb63efd349088f2e8e032df`
- `17e20f9fa382b8a1ebc3cb236fa97d96e834a228`
- `871a50eee64d5d62f1f1a76eb25e0c2a583404cd`
- `04002d1b56c95184cb8f63eaa03fa027e5c958b6`
- `08dbbc99aef68117c09d8d6c51d7057a0d236dac`
- `f8abc126a71b86bb60771a343eaa96ed661c274f`
- `a79d25bc6fc62a3c34d78bf5b2c65bb572430766`
- `c99697c3ec720d121630a13f7263bf47a86328f9`
- `cdd8896555aff5da03ab62196075605c258c250d`
- `67c890ea4e6bab0578477c5e9dc1da2ae73a0b21`
- `32cc9fbbe23aad441d89d4d5670daa345dfdba80`
- `a624b4c7a385c72b32bbeb6e7d992287718b510a`
- `f03fdb848c79a75e92c6d6facfb13121998eaae7`
- `9f72cec97f2639b6b4e3a9a04e2d26d3ac77a3a2`
- `35748571d08f65292c4b966e8bec010c77e1dcae`
- `31b450fb7eeb37848cde0980aa57adfd9b27dc12`
- `5794f7c3f9a312ab8ef085e497c4b0c2b617a331`
- `963eb348a2795196d36700cd908adcef9cb5ec2c`
- `560d6fc9eceec15e566e3fa51843a02e9b4324fc`
- `a38033fce95323fc0312454a3c72ce90938d18f7`
- `c8fb65ea2f59ade68388d3730564b6a87b8fec69`
- `273c953f070367c6275e9cd779591dbd3162ca95`
- `721c6d92af376c644ef4674d346e9c2e87f5f16a`
- `c48b63ec27017b380de0c6ab01c7f16612d3d568`
- `662f735b48d9cd403dda206ae2de60c3a8bb06b0`
- `29cb0ef382c052556864c4a96b5a4ceecfc98af3`
- `4baad6d73a9b4e647a28295a654ad061d000ed2d`
- `c01f6d9ab16e3105fa442ceeae72abfa91dbd3ca`
- `a0c2573965e253280595da6aa92dbcd0fe8869b5`
- `6364b6c59f3694fd88f621ad2b9c4aab46dfcd69`
- `bd0aa709bd94e56b8bacc3ab8dd0e6538f080224`
- `f09839bb2283a7d122381a477c5d0ffade755a8e`
- `4ccdb39eabde0163babaf06b5faac376867b01c1`
- `ea916ebb7ec9d3c0d58a6eb2f46a57a0c804028f`
- `99e7289091e111073a3ab835ca01ea82a5a4e3ce`

### Possible web-flow (separate)

- `9b12bc6bff33a4579da5467ec86d29a5be982449`
- `5ce4427a9473f87bd3478a1e8d544d3e090aa81f`
- `f724e9a4959e1542078b22fa3c1b3c5adb9b0a84`
- `a2ba013ba17a4c3e3d05ccbc4260a72fad620fd5`

