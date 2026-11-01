# ytimesy

Moves your local coding-agent sessions (Claude Code, Codex, Cursor, Gemini CLI,
OpenCode, Pi, Grok) and your work in progress to [ytimesy](https://ytimesy.com).

In ytimesy, open "Continue your agent session" and paste the prompt into your
local agent. It runs:

```sh
npx -y ytimesy continue --code YTM-XXXX-XXXX-XXXX          # plan only
npx -y ytimesy continue --code YTM-XXXX-XXXX-XXXX --scope session
```

The first command prints a plan and uploads nothing. The second pushes your
current work (uncommitted changes included) to a new `ytimesy/...` branch with
your own Git credentials, without touching your working tree, index or current
branch; uploads the sessions (secrets from `.env` redacted) and opens the chat.
A folder without a GitHub repository can get a new private one with
`--create-repo`: it is created with your own GitHub CLI login (`gh`), never
with ytimesy's credentials.
Run `ytimesy --help` for every flag. Requires Node.js 22.13+ (older Node skips OpenCode and Cursor sessions, with a warning). No telemetry.
