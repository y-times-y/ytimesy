"""Harbor 0.24.0 Daytona patches for the TB4 GPU lane (docs/tb4-run-controller.md,
"GPU lane on Daytona"). Imported at interpreter start through
PYTHONPATH=/opt/tb4/daytona by host/run-gpu-trial.sh; does nothing unless Harbor's
Daytona environment is importable.

1. Root user for non-root prebuilt images (stock Daytona mode hangs on them).
2. Pinned-image snapshots: YTIMESY_DAYTONA_SNAPSHOTS = {"<docker_image>": "<snapshot>"};
   the snapshots are built FROM the pinned image plus USER root with
   Resources(gpu=1, gpu_type=[H100]) (daytona-ctl.py snapshot).
3. One GPU at a time (YTIMESY_DAYTONA_ONE_GPU=1): before a GPU sandbox is created, wait
   until the account lists no other GPU sandbox (the previous trial's verifier, or this
   trial's agent sandbox still being deleted); after a delete, wait until it is gone.
   Daytona's limit is one GPU per account; overlap ended two fp8 trials on 2026-10-28.
4. Lifetime log (YTIMESY_DAYTONA_SANDBOX_LOG): one JSON line per create, gpu-assert,
   lost, delete and gone, with the sandbox's billed resources (the controller's spend).
5. H100 assertion (YTIMESY_GPU_ASSERT_FILE): nvidia-smi inside every GPU sandbox right
   after it starts; anything but an H100 raises before the agent or verifier runs.
6. Labels ytimesy-lane=tb4-gpu and ytimesy-attempt=<YTIMESY_ATTEMPT_ID>, so the
   controller can tell its sandboxes from anyone else's.
Never logs credentials.
"""

try:
    import re
    from pathlib import Path

    from harbor.environments.daytona import environment as _de

    _Env = _de.DaytonaEnvironment
    _kwargs = _Env._sandbox_common_kwargs
    _resolve = _Env._resolve_user

    def _image_user(self):
        if not hasattr(self, "_ytimesy_image_user"):
            user = None
            try:
                text = (Path(self.environment_dir) / "Dockerfile").read_text()
                found = re.findall(r"^\s*USER\s+(\S+)", text, re.M | re.I)
                user = found[-1] if found else None
            except Exception:
                pass
            self._ytimesy_image_user = None if user in (None, "root", "0") else user
        return self._ytimesy_image_user

    def _common_kwargs(self):
        kwargs = _kwargs(self)
        if _image_user(self):
            kwargs.setdefault("os_user", "root")
        return kwargs

    def _resolve_user(self, user):
        resolved = _resolve(self, user)
        return resolved if resolved is not None else _image_user(self)

    _Env._sandbox_common_kwargs = _common_kwargs
    _Env._resolve_user = _resolve_user
except Exception:
    pass

try:
    import json as _json
    import os as _os

    from harbor.environments.daytona import environment as _de2

    _Env2 = _de2.DaytonaEnvironment
    _resolve_params = _Env2._resolve_start_sandbox_params

    async def _resolve_start_sandbox_params(self, daytona, resources, *, force_build):
        mapping = _json.loads(_os.environ.get("YTIMESY_DAYTONA_SNAPSHOTS", "{}"))
        snapshot = mapping.get(getattr(self.task_env_config, "docker_image", None) or "")
        if snapshot:
            self.logger.info("Using pinned-image snapshot: %s", snapshot)
            return self._snapshot_sandbox_params(snapshot)
        return await _resolve_params(self, daytona, resources, force_build=force_build)

    _Env2._resolve_start_sandbox_params = _resolve_start_sandbox_params
except Exception:
    pass

try:
    import asyncio as _asyncio
    import inspect as _inspect
    import json as _json3
    import os as _os3
    import time as _time
    from datetime import datetime as _dt
    from datetime import timezone as _tz

    from harbor.environments.daytona import environment as _de3

    _Env3 = _de3.DaytonaEnvironment
    _orig_create = _Env3._create_sandbox
    _orig_stop = _Env3._stop_sandbox
    _orig_labels = _Env3._sandbox_labels
    _GONE = ("destroyed", "archived")
    _POLL = float(_os3.environ.get("YTIMESY_DAYTONA_POLL_SEC", "5"))

    def _now():
        return _dt.now(_tz.utc).isoformat().replace("+00:00", "Z")

    def _log(**fields):
        path = _os3.environ.get("YTIMESY_DAYTONA_SANDBOX_LOG")
        if not path:
            return
        line = _json3.dumps({"at": _now(), **fields})
        fd = _os3.open(path, _os3.O_WRONLY | _os3.O_APPEND | _os3.O_CREAT, 0o644)
        try:
            _os3.write(fd, (line + "\n").encode())
            _os3.fsync(fd)
        finally:
            _os3.close(fd)

    def _state(sb):
        st = getattr(sb, "state", None)
        return str(getattr(st, "value", st) or "unknown").lower()

    def _role(self):
        image = getattr(self.task_env_config, "docker_image", None) or ""
        session = getattr(self, "session_id", "") or ""
        return "verifier" if ("verifier" in image or "__verifier__" in session) else "agent"

    def _one_gpu():
        return _os3.environ.get("YTIMESY_DAYTONA_ONE_GPU", "1") not in ("0", "off", "")

    async def _list_all(client):
        res = client.list()
        if hasattr(res, "__aiter__"):
            return [s async for s in res]
        if _inspect.isawaitable(res):
            res = await res
        return list(getattr(res, "items", res))

    def _labels(self):
        labels = _orig_labels(self)
        attempt = _os3.environ.get("YTIMESY_ATTEMPT_ID")
        if attempt:
            labels = {**labels, "ytimesy-lane": "tb4-gpu", "ytimesy-attempt": attempt}
        return labels

    async def _wait_gpu_free(self, client):
        """Wait until no GPU sandbox other than gone ones is listed; raise after the limit."""
        limit = float(_os3.environ.get("YTIMESY_DAYTONA_GPU_WAIT_SEC", "900"))
        deadline = _time.monotonic() + limit
        logged = False
        while True:
            held = [
                s
                for s in await _list_all(client)
                if (getattr(s, "gpu", 0) or 0) > 0 and _state(s) not in _GONE
            ]
            if not held:
                return
            ids = [f"{s.id[:12]}:{_state(s)}" for s in held]
            if not logged:
                _log(event="gpu-wait", role=_role(self), detail=", ".join(ids))
                logged = True
            if _time.monotonic() > deadline:
                _log(event="gpu-wait-timeout", role=_role(self), detail=", ".join(ids))
                raise RuntimeError(
                    f"ytimesy one-GPU guard: GPU sandbox(es) still live after {int(limit)} s: {', '.join(ids)}"
                )
            await _asyncio.sleep(_POLL)

    async def _assert_h100(self, sb):
        role = _role(self)
        r = await sb.process.exec("nvidia-smi --query-gpu=name --format=csv,noheader", timeout=120)
        name = (getattr(r, "result", "") or "").strip().splitlines()
        gpu = name[0].strip() if name else ""
        _log(event="gpu-assert", id=sb.id, role=role, gpu=gpu[:80])
        path = _os3.environ.get("YTIMESY_GPU_ASSERT_FILE")
        if path:
            with open(path, "a") as f:
                f.write(f"{role} {gpu}\n")
        if "H100" not in gpu:
            raise RuntimeError(f"ytimesy GPU assertion: {role} sandbox reports {gpu!r}, not an NVIDIA H100")

    async def _create_sandbox(self, params, daytona=None):
        gpus = getattr(self, "_effective_gpus", 0) or 0
        if gpus > 0 and _one_gpu():
            client = daytona or await self._client_manager.get_client()
            await _wait_gpu_free(self, client)
        await _orig_create(self, params, daytona)
        sb = self._sandbox
        if sb is None:
            return
        _log(
            event="create",
            id=sb.id,
            role=_role(self),
            snapshot=getattr(params, "snapshot", None),
            cpus=getattr(sb, "cpu", None),
            memoryGiB=getattr(sb, "memory", None),
            storageGiB=getattr(sb, "disk", None),
            gpus=getattr(sb, "gpu", None),
        )
        if gpus > 0:
            await _assert_h100(self, sb)

    async def _wait_gone(client, sandbox_id, role):
        deadline = _time.monotonic() + float(_os3.environ.get("YTIMESY_DAYTONA_GONE_WAIT_SEC", "600"))
        while _time.monotonic() < deadline:
            try:
                sb = await client.get(sandbox_id)
                if _state(sb) in _GONE:
                    break
            except Exception as e:  # DaytonaNotFoundError: deleted
                if "NotFound" in type(e).__name__ or "not found" in str(e).lower():
                    break
            await _asyncio.sleep(_POLL)
        else:
            _log(event="gone-timeout", id=sandbox_id, role=role)
            return
        _log(event="gone", id=sandbox_id, role=role)

    async def _stop_sandbox(self):
        sb = self._sandbox
        client = None
        if sb is not None:
            role = _role(self)
            try:
                client = await self._client_manager.get_client() if self._client_manager else None
            except Exception:
                client = None
            try:
                await sb.refresh_data()
                if _state(sb) not in ("started",):
                    # Auto-stop is off (Harbor's default 0): only the provider stops it.
                    _log(event="lost", id=sb.id, role=role, state=_state(sb))
            except Exception as e:
                if "NotFound" in type(e).__name__ or "not found" in str(e).lower():
                    _log(event="lost", id=sb.id, role=role, state="not found")
            _log(event="delete", id=sb.id, role=role)
        await _orig_stop(self)
        if sb is not None and client is not None and _one_gpu():
            await _wait_gone(client, sb.id, _role(self))

    _Env3._sandbox_labels = _labels
    _Env3._create_sandbox = _create_sandbox
    _Env3._stop_sandbox = _stop_sandbox
except Exception:
    pass

# 4. Large workspaces between the agent and verifier sandboxes. jax-speedrun-gpu agents leave
# 60-150 GB in /app; Harbor packs, downloads and unpacks a directory as one tar.gz with fixed
# 600 s limits, so on 2026-10-14 the verifier got an empty /app. Same bytes and directories;
# only the transport changes:
#  - up to one part (2 GiB): one tar.gz as Harbor does, with 4 h limits;
#  - larger: an uncompressed tar split into 2 GiB parts in the sandbox; each part is downloaded
#    on its own (retried, sha256-checked) into a staging dir on the runner, outside the trial
#    dir (the results sync copies trial dirs), and the artifact dir gets a marker only. Upload
#    sends the parts, checks each, and unpacks them in order. tar's exit 1 ("file changed as we
#    read it") is tolerated; anything else is loud.
try:
    import asyncio as _aio4
    import hashlib as _hl4
    import json as _js4
    import os as _os4
    import shlex as _sh4
    import shutil as _su4
    import tempfile as _tf4
    import uuid as _uu4
    from pathlib import Path as _P4

    from harbor.environments.daytona import environment as _de4

    _Env4 = _de4.DaytonaEnvironment
    _orig_down4 = _Env4._sdk_download_dir
    _orig_up4 = _Env4._sdk_upload_dir
    _LONG4 = int(_os4.environ.get("YTIMESY_DAYTONA_XFER_SEC", str(4 * 3600)))
    _PART4 = int(_os4.environ.get("YTIMESY_DAYTONA_PART_BYTES", str(2 * 1024**3)))
    _RELAY4 = _P4(_os4.environ.get("YTIMESY_DAYTONA_RELAY_DIR", "/var/tmp/ytimesy-relay"))
    _RETRY_SEC4 = float(_os4.environ.get("YTIMESY_DAYTONA_RETRY_SEC", "5"))
    _MARK4 = ".ytimesy-relay.json"
    _q4 = _sh4.quote

    async def _run4(self, command, what):
        r = await self._sandbox_exec(command, shell="sh -c", timeout_sec=_LONG4)
        if r.return_code != 0:
            raise RuntimeError(f"{what} failed ({r.return_code}): {(r.stderr or r.stdout or '')[-800:]}")
        return r.stdout or ""

    async def _retry4(step, what, tries=5):
        for attempt in range(tries):
            try:
                return await step()
            except Exception as error:
                if attempt == tries - 1:
                    raise RuntimeError(f"{what}: {error!r}") from error
                await _aio4.sleep(min(60.0, _RETRY_SEC4 * 2**attempt))

    def _sha4(path):
        h = _hl4.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(8 * 1024**2), b""):
                h.update(block)
        return h.hexdigest()

    def _tar4(source, into):
        return (
            f"rc=$(mktemp); ( tar -cf - -C {_q4(source)} . ; echo $? > $rc ) | {into}"
            f' && s=$(cat $rc) && rm -f $rc && [ "$s" -le 1 ]'
        )

    async def _download_dir4(self, source_dir, target_dir):
        if self._is_windows or not self._sandbox:
            return await _orig_down4(self, source_dir, target_dir)
        target = _P4(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        sized = await _run4(self, f"du -sb {_q4(source_dir)} | cut -f1", f"measure {source_dir}")
        size = int((sized.strip().splitlines() or ["0"])[-1] or 0)
        tid = _uu4.uuid4().hex
        rdir = f"/tmp/ytimesy-xfer-{tid}"
        try:
            if size <= _PART4:
                remote = f"{rdir}/d.tar.gz"
                await _run4(self, f"mkdir -p {_q4(rdir)} && " + _tar4(source_dir, f"gzip -1 > {_q4(remote)}"), f"pack {source_dir}")
                with _tf4.TemporaryDirectory(dir=_os4.environ.get("TMPDIR", "/var/tmp")) as tmp:
                    local = _P4(tmp) / "d.tar.gz"
                    await _retry4(lambda: self._sandbox.fs.download_file(remote, str(local), _LONG4), f"download {remote}")
                    p = await _aio4.create_subprocess_exec("tar", "-xzf", str(local), "-C", str(target))
                    if await p.wait() != 0:
                        raise RuntimeError(f"local unpack of {source_dir} failed")
                return
            await _run4(
                self,
                f"mkdir -p {_q4(rdir)} && " + _tar4(source_dir, f"split -b {_PART4} -d -a 5 - {_q4(rdir)}/part."),
                f"pack {source_dir}",
            )
            listing = await _run4(self, f"cd {_q4(rdir)} && for p in part.*; do echo \"$p $(stat -c %s $p) $(sha256sum $p | cut -d' ' -f1)\"; done", "checksum parts")
            parts = [dict(zip(("name", "bytes", "sha256"), line.split())) for line in listing.strip().splitlines()]
            local_dir = _RELAY4 / tid
            local_dir.mkdir(parents=True, exist_ok=True)
            for part in parts:
                local = local_dir / part["name"]

                async def one(part=part, local=local):
                    await self._sandbox.fs.download_file(f"{rdir}/{part['name']}", str(local), _LONG4)
                    if await _aio4.to_thread(_sha4, local) != part["sha256"]:
                        raise ConnectionError(f"{part['name']}: sha256 mismatch after download")

                await _retry4(one, f"download {part['name']}")
                await _run4(self, f"rm -f {_q4(rdir)}/{_q4(part['name'])}", "free a part")
            total = sum(int(p["bytes"]) for p in parts)
            (target / _MARK4).write_text(_js4.dumps({"relay_dir": str(local_dir), "source": source_dir, "bytes": total, "parts": parts}))
            self.logger.info("Relayed %s (%d bytes, %d parts) to %s", source_dir, total, len(parts), local_dir)
        finally:
            await self._sandbox_exec(f"rm -rf {_q4(rdir)}", shell="sh -c", timeout_sec=600)

    async def _upload_dir4(self, source_dir, target_dir):
        if self._is_windows or not self._sandbox:
            return await _orig_up4(self, source_dir, target_dir)
        source = _P4(source_dir)
        if not source.is_dir():
            raise FileNotFoundError(f"Source directory {source_dir} does not exist")
        rdir = f"/tmp/ytimesy-xfer-{_uu4.uuid4().hex}"
        marker = source / _MARK4
        try:
            await _run4(self, f"mkdir -p {_q4(rdir)} {_q4(target_dir)}", "staging dir")
            if marker.is_file():
                relay = _js4.loads(marker.read_text())
                local_dir = _P4(relay["relay_dir"])
                for part in relay["parts"]:
                    remote = f"{rdir}/{part['name']}"

                    async def one(part=part, remote=remote):
                        await self._sandbox.fs.upload_file(str(local_dir / part["name"]), remote, _LONG4)
                        got = (await _run4(self, f"sha256sum {_q4(remote)} | cut -d' ' -f1", "checksum a part")).strip()
                        if got != part["sha256"]:
                            raise ConnectionError(f"{part['name']}: sha256 mismatch after upload")

                    await _retry4(one, f"upload {part['name']}")
                await _run4(self, f"cat {_q4(rdir)}/part.* | tar -xf - -C {_q4(target_dir)}", f"unpack into {target_dir}")
                _su4.rmtree(local_dir, ignore_errors=True)
                self.logger.info("Restored %s from %d parts (%d bytes)", target_dir, len(relay["parts"]), relay["bytes"])
                return
            remote = f"{rdir}/u.tar.gz"
            with _tf4.TemporaryDirectory(dir=_os4.environ.get("TMPDIR", "/var/tmp")) as tmp:
                archive = _P4(tmp) / "u.tar.gz"
                p = await _aio4.create_subprocess_exec("sh", "-c", _tar4(str(source), f"gzip -1 > {_q4(str(archive))}"))
                if await p.wait() != 0:
                    raise RuntimeError(f"local pack of {source_dir} failed")
                await _retry4(lambda: self._sandbox.fs.upload_file(str(archive), remote, _LONG4), f"upload {source_dir}")
            await _run4(self, f"tar -xzf {_q4(remote)} -C {_q4(target_dir)}", f"unpack into {target_dir}")
        finally:
            await self._sandbox_exec(f"rm -rf {_q4(rdir)}", shell="sh -c", timeout_sec=600)

    _Env4._sdk_download_dir = _download_dir4
    _Env4._sdk_upload_dir = _upload_dir4
except Exception as _error4:
    import sys as _sys4

    print(f"ytimesy daytona transfer patch: NOT APPLIED ({_error4!r})", file=_sys4.stderr)
