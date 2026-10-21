import { privateDirectoryShell } from "#/domain/posix-command";

/**
 * The builder's private desktop directory (0700, the builder's own): the X
 * cookie, the viewer credential the runtime drops for the start script, the
 * proxy's copy of it and the digest it runs with. Created and verified by
 * DESKTOP_CREDENTIAL_DROP_SETUP before anything is written into it, so no
 * other user on the VM (a read-only agent) can pre-create, link or read it.
 */
export const DESKTOP_PRIVATE_DIRECTORY = "/tmp/ytimesy-desktop-private";
export const DESKTOP_VIEWER_CREDENTIAL_PATH = `${DESKTOP_PRIVATE_DIRECTORY}/viewer.auth`;
export const DESKTOP_XAUTHORITY = `${DESKTOP_PRIVATE_DIRECTORY}/Xauthority`;
/** The VNC password the runtime drops; x11vnc asks every client for it. */
export const DESKTOP_VNC_PASSWORD_PATH = `${DESKTOP_PRIVATE_DIRECTORY}/vnc.password`;
const DESKTOP_AUTH_APPLIED = `${DESKTOP_PRIVATE_DIRECTORY}/viewer.applied`;

/** What every X client of the builder exports, whatever its HOME. */
export const DESKTOP_X_ENVIRONMENT = `export DISPLAY=:0 XAUTHORITY=${DESKTOP_XAUTHORITY}`;

/**
 * Creates the private directory 0700 as the builder, and refuses (non-zero)
 * when the path is a link, not a directory, owned by another user or not
 * 0700: e.g. one another user created first in the shared /tmp.
 */
const DESKTOP_PRIVATE_DIRECTORY_CHECK = `dir=${DESKTOP_PRIVATE_DIRECTORY}
refuse() { echo "ytimesy: $dir is not this user's private directory; refusing the desktop credential" >&2; exit 1; }
if [ -L "$dir" ] || { [ -e "$dir" ] && { [ ! -d "$dir" ] || [ ! -O "$dir" ]; }; }; then refuse; fi
install -d -o "$(id -un)" -m 0700 "$dir" 2>/dev/null || refuse
[ ! -L "$dir" ] && [ -O "$dir" ] || refuse
case "$(ls -ld "$dir")" in drwx------*) ;; *) refuse ;; esac`;

/**
 * Run as the builder before the runtime writes the viewer credential: the
 * directory check, then any earlier drop removed, so the runtime's write
 * creates a fresh file that only the builder (or root) could have placed.
 * Prints DESKTOP_PRIVATE_READY on success.
 */
export const DESKTOP_PRIVATE_READY = "YTIMESY_DESKTOP_PRIVATE_READY";
export const DESKTOP_CREDENTIAL_DROP_SETUP = `${DESKTOP_PRIVATE_DIRECTORY_CHECK}
rm -f "$dir/viewer.auth" "$dir/vnc.password"
echo ${DESKTOP_PRIVATE_READY}`;

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

if ! command -v Xvfb >/dev/null 2>&1 || ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1 || ! command -v xauth >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends xvfb xauth x11vnc websockify fluxbox xterm feh tint2 pcmanfm
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
# The display, its viewer and Chrome's DevTools belong to this user only: X
# clients need the cookie in the private directory (a fixed path, so clients
# without HOME find it), and read-only agents (another Linux user on the same
# VM) have neither it nor loopback TCP.
(
${DESKTOP_PRIVATE_DIRECTORY_CHECK}
)
DESK_PRIVATE=${DESKTOP_PRIVATE_DIRECTORY}
XAUTH=${DESKTOP_XAUTHORITY}
export XAUTHORITY="$XAUTH"
if ! grep -q '${DESKTOP_XAUTHORITY}' "$PROFILE" 2>/dev/null; then
  sed -i '/XAUTHORITY=/d' "$PROFILE" 2>/dev/null || true
  printf 'export XAUTHORITY=${DESKTOP_XAUTHORITY}\\n' >> "$PROFILE"
fi
# A display started with the cookie in ~/.Xauthority keeps running: its
# cookie moves to the private directory.
if [ ! -s "$XAUTH" ] && [ -s "\${HOME}/.Xauthority" ] && pgrep -x Xvfb >/dev/null 2>&1; then
  (umask 077; cat "\${HOME}/.Xauthority" > "$XAUTH")
fi
printf ':0\\n' > /tmp/ytimesy-display

if [ ! -s /tmp/ytimesy-desktop-wallpaper.b64 ]; then
  echo "ytimesy desktop wallpaper is missing" >&2
  exit 1
fi
WALL_DIR="\${HOME}/.ytimesy"
WALLPAPER="$WALL_DIR/desktop-wallpaper.png"
mkdir -p "$WALL_DIR" "\${HOME}/.fluxbox"
${privateDirectoryShell("/tmp/ytimesy-chrome-profile")}
base64 -d /tmp/ytimesy-desktop-wallpaper.b64 > "$WALLPAPER"
if [ ! -s "$WALLPAPER" ]; then
  echo "ytimesy desktop wallpaper could not be decoded" >&2
  exit 1
fi
printf 'session.screen0.rootCommand: feh --bg-fill %s\\n' "$WALLPAPER" > "\${HOME}/.fluxbox/overlay"
write_desktop_launchers

# A desktop started before access control (-ac, a TCP viewer without a
# password) restarts locked down. Chrome cannot outlive its display: it is
# closed first (its profile keeps the tabs) and reopened on the new one.
CHROME_REOPEN=0
if pgrep -f '[X]vfb :0 .*-ac' >/dev/null 2>&1; then
  if pgrep -x 'chrome|chromium|chromium-browse' >/dev/null 2>&1; then
    CHROME_REOPEN=1
    pkill -TERM -x 'chrome|chromium|chromium-browse' >/dev/null 2>&1 || true
    sleep 2
  fi
  pkill -x x11vnc >/dev/null 2>&1 || true
  pkill -x Xvfb >/dev/null 2>&1 || true
  sleep 1
fi
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  (umask 077; touch "$XAUTH")
  chmod 600 "$XAUTH"
  cookie="$(mcookie 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(16))')"
  # printf is a builtin, so the cookie never appears in a process list.
  printf 'add :0 . %s\\n' "$cookie" | xauth -q -f "$XAUTH" source -
  Xvfb :0 -screen 0 1440x900x24 -auth "$XAUTH" -nolisten tcp >/tmp/ytimesy-xvfb.log 2>&1 &
  sleep 1
fi
export DISPLAY=:0
# The builder's own processes reach the display without the cookie too (by
# uid over the local socket); any other user still needs the cookie.
if ! command -v xhost >/dev/null 2>&1; then
  apt_get install -y -qq --no-install-recommends x11-xserver-utils >/dev/null 2>&1 || true
fi
xhost "+SI:localuser:$(id -un)" >/dev/null 2>&1 || true
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
elif [ "$CHROME_REOPEN" = 1 ] && ! pgrep -x 'chrome|chromium|chromium-browse' >/dev/null 2>&1; then
  nohup "$(find_chrome_bin)" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-session-crashed-bubble --restore-last-session --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/ytimesy-chrome-profile >/tmp/ytimesy-api-browser.log 2>&1 </dev/null &
fi
# VNC listens only on a Unix socket in a 0700 directory, never on TCP (IPv4
# or IPv6: x11vnc's -rfbport 0 alone still listened on [::]:5900), and asks
# for the VNC password the runtime drops (the owner's viewer gets it from the
# server); the proxy below is its one client. A desktop on TCP, or on an
# older password, restarts its x11vnc; the display and Chrome stay.
VNC_DIR="\${HOME}/.ytimesy/vnc"
VNC_SOCKET="$VNC_DIR/rfb.sock"
VNC_PASS_DROP=${DESKTOP_VNC_PASSWORD_PATH}
VNC_PASS_FILE="$DESK_PRIVATE/vnc.passwd"
VNC_APPLIED="$DESK_PRIVATE/vnc.applied"
if [ -f "$VNC_PASS_DROP" ] && [ ! -L "$VNC_PASS_DROP" ]; then
  (umask 077; head -n 1 "$VNC_PASS_DROP" > "$VNC_PASS_FILE.new")
  mv -f "$VNC_PASS_FILE.new" "$VNC_PASS_FILE"
  rm -f "$VNC_PASS_DROP"
fi
if [ ! -s "$VNC_PASS_FILE" ]; then
  (umask 077; od -An -tx1 -N4 /dev/urandom | tr -d ' \\n' > "$VNC_PASS_FILE")
fi
VNC_PASS_DIGEST="$(sha256sum "$VNC_PASS_FILE" | cut -d' ' -f1)"
vnc_on_tcp() { ss -ltnH 2>/dev/null | grep -qE ':590[0-9][[:space:]]'; }
if pgrep -x x11vnc >/dev/null 2>&1 && { vnc_on_tcp || [ "$(cat "$VNC_APPLIED" 2>/dev/null)" != "$VNC_PASS_DIGEST" ]; }; then
  pkill -x x11vnc >/dev/null 2>&1 || true
  sleep 1
fi
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  install -d -m 0700 "$VNC_DIR"
  rm -f "$VNC_SOCKET"
  x11vnc -display :0 -auth "$XAUTH" -forever -shared -passwdfile "$VNC_PASS_FILE" -unixsock "$VNC_SOCKET" -rfbport 0 -rfbportv6 -1 -noipv6 -localhost >/tmp/ytimesy-desk.log 2>&1 &
  sleep 1
  printf '%s' "$VNC_PASS_DIGEST" > "$VNC_APPLIED"
fi
if vnc_on_tcp; then
  pkill -x x11vnc >/dev/null 2>&1 || true
  echo "ytimesy: x11vnc listened on TCP; it was stopped and the desktop refused" >&2
  exit 1
fi
# The viewer port is published at the edge, so it only listens publicly behind
# the server-held credential (BasicHTTPAuth). Without one it stays local. The
# credential is read from its 0600 file by a small plugin, never put in argv
# where any user's process list shows it. The runtime drops it in the private
# directory; it becomes the proxy's own 0600 copy there.
DESK_AUTH_DROP=${DESKTOP_VIEWER_CREDENTIAL_PATH}
DESK_AUTH_FILE="$DESK_PRIVATE/viewer.credential"
DESK_AUTH_APPLIED=${DESKTOP_AUTH_APPLIED}
if [ -f "$DESK_AUTH_DROP" ] && [ ! -L "$DESK_AUTH_DROP" ]; then
  (umask 077; cat "$DESK_AUTH_DROP" > "$DESK_AUTH_FILE.new")
  mv -f "$DESK_AUTH_FILE.new" "$DESK_AUTH_FILE"
  rm -f "$DESK_AUTH_DROP"
fi
DESK_AUTH_PLUGIN="\${HOME}/.ytimesy/desk-auth"
mkdir -p "$DESK_AUTH_PLUGIN"
cat > "$DESK_AUTH_PLUGIN/ytimesy_desk_auth.py" <<'PY'
from websockify.auth_plugins import BasicHTTPAuth


class FileBasicHTTPAuth(BasicHTTPAuth):
    """BasicHTTPAuth with user:password read from the file named by --auth-source."""

    def __init__(self, src=None):
        with open(src) as source:
            super().__init__(source.read().rstrip("\\n"))
PY
desk_proxy_listening() { ss -ltn | grep -q ':6080 '; }
# A proxy from before the Unix-socket viewer forwards to a port nothing serves.
desk_proxy_current() { pgrep -f "[w]ebsockify.*--unix-target=$VNC_SOCKET" >/dev/null 2>&1; }
if [ -s "$DESK_AUTH_FILE" ]; then
  DESK_AUTH_DIGEST="$(sha256sum "$DESK_AUTH_FILE" | cut -d' ' -f1)"
  if ! desk_proxy_listening || ! desk_proxy_current || [ "$(cat "$DESK_AUTH_APPLIED" 2>/dev/null)" != "$DESK_AUTH_DIGEST" ]; then
    pkill -x websockify >/dev/null 2>&1 || true
    sleep 1
    PYTHONPATH="$DESK_AUTH_PLUGIN" websockify --auth-plugin ytimesy_desk_auth.FileBasicHTTPAuth --auth-source "$DESK_AUTH_FILE" --unix-target="$VNC_SOCKET" 0.0.0.0:6080 >/tmp/ytimesy-desk-proxy.log 2>&1 &
    sleep 1
    printf '%s' "$DESK_AUTH_DIGEST" > "$DESK_AUTH_APPLIED"
  fi
else
  if ss -ltn | grep -qF -e '0.0.0.0:6080 ' -e '*:6080 ' -e '[::]:6080 ' || { desk_proxy_listening && ! desk_proxy_current; }; then
    pkill -x websockify >/dev/null 2>&1 || true
    sleep 1
  fi
  if ! desk_proxy_listening || ! desk_proxy_current; then
    websockify --unix-target="$VNC_SOCKET" 127.0.0.1:6080 >/tmp/ytimesy-desk-proxy.log 2>&1 &
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
${DESKTOP_X_ENVIRONMENT}
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
    with open("${DESKTOP_AUTH_APPLIED}") as applied:
        current = applied.read().strip() == "${credentialDigest}"
    print("YTIMESY_DESKTOP_UP" if current else "YTIMESY_DESKTOP_DOWN")
except Exception:
    print("YTIMESY_DESKTOP_DOWN")
finally:
    probe.close()
PY
`;
}
