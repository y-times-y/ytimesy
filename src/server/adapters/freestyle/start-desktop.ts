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

install_google_chrome() {
  if command -v google-chrome-stable >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1; then
    return 0
  fi
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends wget ca-certificates fonts-liberation
  wget -q --timeout=90 -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt_get install -y -qq /tmp/google-chrome.deb
}

chrome_is_running() {
  pgrep -x chrome >/dev/null 2>&1 || pgrep -x chromium >/dev/null 2>&1 || pgrep -x chromium-browser >/dev/null 2>&1
}

find_chrome_bin() {
  for bin in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '%s' "$bin"
      return 0
    fi
  done
  return 1
}

if ! command -v Xvfb >/dev/null 2>&1 || ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends xvfb x11vnc novnc websockify fluxbox xterm feh
fi
if ! command -v feh >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends feh
fi
if ! command -v xdotool >/dev/null 2>&1 || ! command -v scrot >/dev/null 2>&1; then
  apt_get install -y -qq --no-install-recommends xdotool scrot x11-utils dbus-x11 fonts-liberation || true
fi
if ! find_chrome_bin >/dev/null 2>&1; then
  (
    if ! install_google_chrome; then
      apt_get update -qq
      apt_get install -y -qq --no-install-recommends chromium || apt_get install -y -qq --no-install-recommends chromium-browser || true
    fi
  ) >/tmp/ytimesy-chrome-install.log 2>&1 &
fi

PROFILE="\${HOME}/.profile"
touch "$PROFILE"
if ! grep -q 'DISPLAY=:0' "$PROFILE" 2>/dev/null; then
  printf '\\nexport DISPLAY=:0\\n' >> "$PROFILE"
fi
printf ':0\\n' > /tmp/ytimesy-display

if [ ! -s /tmp/ytimesy-desktop-wallpaper.b64 ]; then
  echo "ytimesy desktop wallpaper is missing" >&2
  exit 1
fi
WALL_DIR="\${HOME}/.ytimesy"
WALLPAPER="$WALL_DIR/desktop-wallpaper.png"
mkdir -p "$WALL_DIR" "\${HOME}/.fluxbox" /tmp/ytimesy-chrome-profile
base64 -d /tmp/ytimesy-desktop-wallpaper.b64 > "$WALLPAPER"
if [ ! -s "$WALLPAPER" ]; then
  echo "ytimesy desktop wallpaper could not be decoded" >&2
  exit 1
fi
printf 'session.screen0.rootCommand: feh --bg-fill %s\\n' "$WALLPAPER" > "\${HOME}/.fluxbox/overlay"

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb :0 -screen 0 1440x900x24 -ac >/tmp/ytimesy-xvfb.log 2>&1 &
  sleep 1
fi
export DISPLAY=:0
if ! pgrep -x fluxbox >/dev/null 2>&1; then
  fluxbox >/tmp/ytimesy-fluxbox.log 2>&1 &
  sleep 1
fi
if ! feh --bg-fill "$WALLPAPER" >/tmp/ytimesy-wallpaper.log 2>&1; then
  sleep 1
  feh --bg-fill "$WALLPAPER" >/tmp/ytimesy-wallpaper.log 2>&1
fi

chrome_bin="$(find_chrome_bin || true)"
if [ -n "$chrome_bin" ] && ! chrome_is_running; then
  rm -rf /tmp/ytimesy-chrome-profile
  mkdir -p /tmp/ytimesy-chrome-profile
  "$chrome_bin" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-session-crashed-bubble --test-type --user-data-dir=/tmp/ytimesy-chrome-profile --window-size=720,640 --window-position=680,160 about:blank >/tmp/ytimesy-browser.log 2>&1 &
  i=0
  while [ "$i" -lt 10 ]; do
    if chrome_is_running; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
fi
if [ -z "$chrome_bin" ]; then
  echo "Chrome is still installing; desktop is up on DISPLAY=:0" >&2
fi
chrome_window=""
if [ -n "$chrome_bin" ] && command -v xdotool >/dev/null 2>&1; then
  i=0
  while [ "$i" -lt 15 ]; do
    chrome_window="$(xdotool search --onlyvisible --class 'Google-chrome' 2>/dev/null | head -n 1 || true)"
    if [ -z "$chrome_window" ]; then
      chrome_window="$(xdotool search --onlyvisible --name 'Google Chrome' 2>/dev/null | head -n 1 || true)"
    fi
    if [ -z "$chrome_window" ]; then
      chrome_window="$(xdotool search --onlyvisible --class Chromium 2>/dev/null | head -n 1 || true)"
    fi
    if [ -n "$chrome_window" ]; then
      xdotool windowmove "$chrome_window" 680 160 >/dev/null 2>&1 || true
      xdotool windowsize "$chrome_window" 720 640 >/dev/null 2>&1 || true
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ -z "$chrome_window" ]; then
    echo "Chrome is running but has no window on DISPLAY=:0" >&2
    cat /tmp/ytimesy-browser.log >&2 || true
  fi
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

export const PROBE_WORKSPACE_DESKTOP = `python3 - <<'PY'
import socket
probe = socket.socket()
probe.settimeout(1)
try:
    probe.connect(("127.0.0.1", 6080))
    print("YTIMESY_DESKTOP_UP")
except Exception:
    print("YTIMESY_DESKTOP_DOWN")
finally:
    probe.close()
PY
`;
