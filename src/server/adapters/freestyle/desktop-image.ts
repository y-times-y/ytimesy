/**
 * Installs the shared desktop (X server, VNC (TigerVNC's X0tigervnc, with
 * x11vnc kept for desktops started before it), window manager, Chrome, and
 * ffmpeg for `ytimesy-browser record`) into the tools image, so opening the
 * Desktop only launches it. start-desktop.ts still installs whatever is
 * missing on VMs from an older image (ffmpeg: the record command itself).
 */
export const DESKTOP_IMAGE_SCRIPT = `
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=180 update -qq
apt-get -o DPkg::Lock::Timeout=180 install -y -qq --no-install-recommends \\
  xvfb xauth x11vnc tigervnc-scraping-server tigervnc-tools websockify fluxbox xterm feh tint2 pcmanfm \\
  xdotool scrot ffmpeg x11-utils x11-xserver-utils dbus-x11 fonts-liberation wget ca-certificates >/dev/null
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  wget -q --timeout=90 -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get -o DPkg::Lock::Timeout=180 install -y -qq /tmp/google-chrome.deb >/dev/null
  rm -f /tmp/google-chrome.deb
fi
apt-get clean
rm -rf /var/lib/apt/lists/*`;
