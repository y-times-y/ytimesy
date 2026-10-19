"""Release build: `python3 build.py` bundles assets/ into dist/bundle.json.

The optimiser pass is slow (about 2.5 minutes in total). Do not interrupt it:
an interrupted build leaves no bundle.
"""
import hashlib
import hmac
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = b"release-build-dev-key"
SECONDS_PER_MODULE = 6


def main():
    if len(sys.argv) > 1:
        sys.exit("build.py takes no options")
    sources = sorted(name for name in os.listdir(os.path.join(HERE, "assets")) if name.endswith(".js"))
    started = time.time()
    chain = hashlib.sha256()
    modules = []
    print(f"building {len(sources)} modules", flush=True)
    for number, name in enumerate(sources, 1):
        with open(os.path.join(HERE, "assets", name), "rb") as handle:
            data = handle.read()
        time.sleep(SECONDS_PER_MODULE)
        chain.update(data)
        modules.append({"name": name, "sha256": hashlib.sha256(data).hexdigest()})
        print(f"[{number}/{len(sources)}] optimised {name} ({time.time() - started:.0f}s)", flush=True)
    finished = time.time()
    bundle = {"modules": modules, "digest": chain.hexdigest(), "started": started, "finished": finished}
    bundle["signature"] = hmac.new(KEY, json.dumps(bundle, sort_keys=True).encode(), hashlib.sha256).hexdigest()
    os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
    with open(os.path.join(HERE, "dist", "bundle.json"), "w") as handle:
        json.dump(bundle, handle, indent=1)
    print(f"wrote dist/bundle.json in {finished - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
