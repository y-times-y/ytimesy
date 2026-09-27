export const REMOVE_CODEX_CREDENTIAL_FILES = `set -eu
rm -f "$HOME/.codex/auth.json" \
  /tmp/ytimesy-codex-external-tokens.json \
  /tmp/ytimesy-codex-refresh-request.json \
  /tmp/ytimesy-codex-refresh-response.json
if command -v sudo >/dev/null 2>&1; then
  sudo -n rm -f /root/.codex/auth.json
fi
if [ -d /tmp/ytimesy-sessions ]; then
  find /tmp/ytimesy-sessions -type f '(' \
    -name 'ytimesy-codex-external-tokens.json' -o \
    -name 'ytimesy-codex-refresh-request.json' -o \
    -name 'ytimesy-codex-refresh-response.json' \
  ')' -delete
fi
test ! -e "$HOME/.codex/auth.json"
`;
