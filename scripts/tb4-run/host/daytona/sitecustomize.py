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
