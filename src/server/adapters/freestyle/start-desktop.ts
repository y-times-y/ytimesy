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

find_chrome_bin() {
  for bin in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '%s' "$bin"
      return 0
    fi
  done
  return 1
}

apply_guest_identity() {
  if command -v sudo >/dev/null 2>&1; then
    sudo -n hostname ytimesy >/dev/null 2>&1 || true
    printf 'ytimesy\\n' | sudo -n tee /etc/hostname >/dev/null 2>&1 || true
  fi
  hostname ytimesy >/dev/null 2>&1 || true
  export HOSTNAME=ytimesy
  if [ -w /etc/hostname ]; then
    printf 'ytimesy\\n' > /etc/hostname
  fi
  if [ -w /etc/hosts ] && ! grep -q '[[:space:]]ytimesy$' /etc/hosts 2>/dev/null; then
    printf '127.0.1.1 ytimesy\\n' >> /etc/hosts
  fi
  PROFILE="\${HOME}/.bashrc"
  touch "$PROFILE"
  if ! grep -q 'ytimesy guest prompt' "$PROFILE" 2>/dev/null; then
    printf '\\n# ytimesy guest prompt\\nexport HOSTNAME=ytimesy\\nexport PS1="\\\\u@ytimesy:\\\\w\\\\$ "\\n' >> "$PROFILE"
  fi
  if ! grep -q 'ytimesy guest cli pin' "$PROFILE" 2>/dev/null; then
    printf '\\n# ytimesy guest cli pin\\nif [ -f /tmp/ytimesy-guest-cli-pin.env ]; then . /tmp/ytimesy-guest-cli-pin.env; fi\\nexport DISABLE_AUTOUPDATER=1\\nexport DISABLE_UPDATES=1\\nexport OPENCODE_DISABLE_AUTOUPDATE=true\\n' >> "$PROFILE"
  fi
}

write_desktop_launchers() {
  DESK_DIR="\${HOME}/.ytimesy/desk"
  mkdir -p "$DESK_DIR" "\${HOME}/.config/tint2" "\${HOME}/.fluxbox"
  cat > "$DESK_DIR/chrome.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Chrome
Exec=/bin/sh -c 'bin=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser); exec "$bin" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-session-crashed-bubble --test-type --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/ytimesy-chrome-profile'
Icon=google-chrome
Terminal=false
EOF
  cat > "$DESK_DIR/terminal.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xterm -fa Monospace -fs 12 -bg black -fg white -T Terminal -e bash -lc 'export HOSTNAME=ytimesy PS1="\\u@ytimesy:\\w\\$ "; cd ~; exec bash --norc --noprofile'
Icon=utilities-terminal
Terminal=false
EOF
  cat > "$DESK_DIR/files.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Files
Exec=pcmanfm
Icon=system-file-manager
Terminal=false
EOF
  cat > "\${HOME}/.config/tint2/tint2rc" <<EOF
# ytimesy desktop dock
rounded = 22
border_width = 0
background_color = #1a1a1a 90
border_color = #000000 0
panel_monitor = all
panel_position = bottom center horizontal
panel_size = 0 64
panel_margin = 0 18
panel_padding = 14 10 16
panel_background_id = 1
panel_items = L
wm_menu = 0
panel_dock = 1
autohide = 0
launcher_padding = 8 6 14
launcher_background_id = 0
launcher_icon_size = 40
launcher_item_app = $DESK_DIR/chrome.desktop
launcher_item_app = $DESK_DIR/terminal.desktop
launcher_item_app = $DESK_DIR/files.desktop
EOF
  if ! grep -q 'toolbar.visible' "\${HOME}/.fluxbox/init" 2>/dev/null; then
    printf 'session.screen0.toolbar.visible: false\\n' >> "\${HOME}/.fluxbox/init"
  fi
}

if ! command -v Xvfb >/dev/null 2>&1 || ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends xvfb x11vnc websockify fluxbox xterm feh tint2 pcmanfm
fi
if ! command -v tint2 >/dev/null 2>&1 || ! command -v pcmanfm >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends tint2 pcmanfm || true
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

apply_guest_identity
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
write_desktop_launchers

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
if command -v tint2 >/dev/null 2>&1; then
  pkill -x tint2 >/dev/null 2>&1 || true
  tint2 -c "\${HOME}/.config/tint2/tint2rc" >/tmp/ytimesy-dock.log 2>&1 &
fi
if ! find_chrome_bin >/dev/null 2>&1; then
  echo "Chrome is still installing; desktop is up on DISPLAY=:0" >&2
fi
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  x11vnc -display :0 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 >/tmp/ytimesy-desk.log 2>&1 &
  sleep 1
fi
# The viewer port is published at the edge, so it only listens publicly behind
# the server-held credential (BasicHTTPAuth). Without one it stays local.
DESK_AUTH_FILE=/tmp/ytimesy-desk-viewer.auth
DESK_AUTH_APPLIED=/tmp/ytimesy-desk-auth.applied
desk_proxy_listening() { ss -ltn | grep -q ':6080 '; }
if [ -s "$DESK_AUTH_FILE" ]; then
  chmod 600 "$DESK_AUTH_FILE"
  DESK_AUTH_DIGEST="$(sha256sum "$DESK_AUTH_FILE" | cut -d' ' -f1)"
  if ! desk_proxy_listening || [ "$(cat "$DESK_AUTH_APPLIED" 2>/dev/null)" != "$DESK_AUTH_DIGEST" ]; then
    pkill -f 'websockify.*:6080' >/dev/null 2>&1 || true
    sleep 1
    websockify --auth-plugin websockify.auth_plugins.BasicHTTPAuth --auth-source "$(cat "$DESK_AUTH_FILE")" 0.0.0.0:6080 127.0.0.1:5900 >/tmp/ytimesy-desk-proxy.log 2>&1 &
    sleep 1
    printf '%s' "$DESK_AUTH_DIGEST" > "$DESK_AUTH_APPLIED"
  fi
else
  if ss -ltn | grep -qF -e '0.0.0.0:6080 ' -e '*:6080 ' -e '[::]:6080 '; then
    pkill -f 'websockify.*:6080' >/dev/null 2>&1 || true
    sleep 1
  fi
  if ! desk_proxy_listening; then
    websockify 127.0.0.1:6080 127.0.0.1:5900 >/tmp/ytimesy-desk-proxy.log 2>&1 &
    sleep 1
  fi
fi
python3 - <<'PY'
import json
print("YTIMESY_DESKTOP=" + json.dumps({"display": ":0", "port": 6080}))
PY
`;

export const ENSURE_WORKSPACE_DESKTOP = `set -eu
export DEBIAN_FRONTEND=noninteractive
export HOME="\${HOME:-/root}"
export DISPLAY=:0
if command -v sudo >/dev/null 2>&1; then
  sudo -n hostname ytimesy >/dev/null 2>&1 || true
fi
hostname ytimesy >/dev/null 2>&1 || true
if ! command -v tint2 >/dev/null 2>&1 || ! command -v pcmanfm >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo -n apt-get update -qq
    sudo -n apt-get install -y -qq --no-install-recommends tint2 pcmanfm || true
  else
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends tint2 pcmanfm || true
  fi
fi
DESK_DIR="\${HOME}/.ytimesy/desk"
mkdir -p "$DESK_DIR" "\${HOME}/.config/tint2" "\${HOME}/.fluxbox"
cat > "$DESK_DIR/chrome.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Chrome
Exec=/bin/sh -c 'bin=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser); exec "$bin" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-session-crashed-bubble --test-type --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/ytimesy-chrome-profile'
Icon=google-chrome
Terminal=false
EOF
cat > "$DESK_DIR/terminal.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xterm -fa Monospace -fs 12 -bg black -fg white -T Terminal -e bash -lc 'export HOSTNAME=ytimesy PS1="\\u@ytimesy:\\w\\$ "; cd ~; exec bash --norc --noprofile'
Icon=utilities-terminal
Terminal=false
EOF
cat > "$DESK_DIR/files.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Files
Exec=pcmanfm
Icon=system-file-manager
Terminal=false
EOF
cat > "\${HOME}/.config/tint2/tint2rc" <<EOF
rounded = 22
border_width = 0
background_color = #1a1a1a 90
border_color = #000000 0
panel_monitor = all
panel_position = bottom center horizontal
panel_size = 0 64
panel_margin = 0 18
panel_padding = 14 10 16
panel_background_id = 1
panel_items = L
panel_dock = 1
launcher_padding = 8 6 14
launcher_icon_size = 40
launcher_item_app = $DESK_DIR/chrome.desktop
launcher_item_app = $DESK_DIR/terminal.desktop
launcher_item_app = $DESK_DIR/files.desktop
EOF
if command -v tint2 >/dev/null 2>&1; then
  pkill -x tint2 >/dev/null 2>&1 || true
  tint2 -c "\${HOME}/.config/tint2/tint2rc" >/tmp/ytimesy-dock.log 2>&1 &
fi
`;

/** Up only when the viewer proxy listens with the credential whose digest is given. */
export function probeWorkspaceDesktop(credentialDigest: string) {
	if (!/^[a-f0-9]{64}$/.test(credentialDigest))
		throw new Error("Desktop credential digest must be SHA-256 hex.");
	return `python3 - <<'PY'
import socket
probe = socket.socket()
probe.settimeout(1)
try:
    probe.connect(("127.0.0.1", 6080))
    with open("/tmp/ytimesy-desk-auth.applied") as applied:
        current = applied.read().strip() == "${credentialDigest}"
    print("YTIMESY_DESKTOP_UP" if current else "YTIMESY_DESKTOP_DOWN")
except Exception:
    print("YTIMESY_DESKTOP_DOWN")
finally:
    probe.close()
PY
`;
}

export const DESKTOP_VIEWER_CREDENTIAL_PATH = "/tmp/ytimesy-desk-viewer.auth";
