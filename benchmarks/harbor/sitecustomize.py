"""Loaded by Python at startup when benchmarks/harbor is on PYTHONPATH.

Modal may serve a plain "H100" request on a faster H200; "H100!" pins the
GPU type the task specifies, so Modal trials run on exactly an H100.
"""
try:
    from harbor.environments import modal as _modal

    _original = _modal.ModalEnvironment._gpu_config

    def _exact_gpu_config(self):
        config = _original(self)
        if config and ":" in config:
            kind, count = config.split(":", 1)
            if kind != "any" and not kind.endswith("!"):
                return f"{kind}!:{count}"
        return config

    _modal.ModalEnvironment._gpu_config = _exact_gpu_config
except Exception:  # Harbor or Modal not installed in this interpreter
    pass
