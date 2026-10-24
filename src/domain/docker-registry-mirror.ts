/** Google's pull-through cache of Docker Hub; blobs are served from the same host. */
export const DOCKER_HUB_MIRROR = "https://mirror.gcr.io";

/**
 * Docker Hub rate-limits the provider's shared VM IPs (429 Too Many
 * Requests). Pulls go through Google's mirror; Docker falls back to Docker
 * Hub itself when the mirror fails. The mirror is merged into daemon.json:
 * other settings, and mirrors already listed (which stay first), are kept;
 * a daemon.json that is not a JSON object is left alone and the script
 * fails. A running Docker restarts to read it.
 */
export function dockerRegistryMirrorScript(
	path = "/etc/docker/daemon.json",
	restartDocker = true,
) {
	return `python3 - ${JSON.stringify(path)} ${JSON.stringify(DOCKER_HUB_MIRROR)} <<'PY'
import json, os, sys
path, mirror = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        config = json.load(f)
except FileNotFoundError:
    config = {}
if not isinstance(config, dict):
    sys.exit(path + " is not a JSON object; left unchanged")
mirrors = config.get("registry-mirrors") or []
if mirror not in mirrors:
    config["registry-mirrors"] = mirrors + [mirror]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(config, f, indent=2)
    os.replace(path + ".tmp", path)
PY${
		restartDocker
			? "\nif command -v systemctl >/dev/null 2>&1; then systemctl try-restart docker 2>/dev/null || true; fi"
			: ""
	}`;
}
