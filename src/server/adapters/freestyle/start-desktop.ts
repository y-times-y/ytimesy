export const START_WORKSPACE_DESKTOP = `set -eu
export DEBIAN_FRONTEND=noninteractive
export HOME="\${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"

apt_get() {
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo -n apt-get "$@"
  else
    apt-get "$@"
  fi
}

if ! command -v Xvfb >/dev/null 2>&1 || ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends xvfb x11vnc novnc websockify fluxbox xterm
fi
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb :0 -screen 0 1440x900x24 -ac >/tmp/ytimesy-xvfb.log 2>&1 &
  sleep 1
fi
export DISPLAY=:0
if ! pgrep -x fluxbox >/dev/null 2>&1; then
  fluxbox >/tmp/ytimesy-fluxbox.log 2>&1 &
fi
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  x11vnc -display :0 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 >/tmp/ytimesy-x11vnc.log 2>&1 &
  sleep 1
fi
WEBROOT=""
if [ -d /usr/share/novnc ]; then
  WEBROOT=/usr/share/novnc
elif [ -d /usr/share/novnc/noVNC ]; then
  WEBROOT=/usr/share/novnc/noVNC
fi
if ! ss -ltn | grep -q ':6080'; then
  if [ -n "$WEBROOT" ]; then
    websockify --web="$WEBROOT" 0.0.0.0:6080 127.0.0.1:5900 >/tmp/ytimesy-novnc.log 2>&1 &
  else
    websockify 0.0.0.0:6080 127.0.0.1:5900 >/tmp/ytimesy-novnc.log 2>&1 &
  fi
  sleep 1
fi
python3 - <<'PY'
import json
print("YTIMESY_DESKTOP=" + json.dumps({"display": ":0", "port": 6080}))
PY
`;
