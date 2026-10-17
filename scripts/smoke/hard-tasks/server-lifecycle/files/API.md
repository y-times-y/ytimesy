# Licensing service API

Start: `python3 server.py [--port PORT]` (default 8790). It loads its license
index for a few seconds before it listens. All bodies are JSON.

| Method | Path | Body / headers | Reply |
| --- | --- | --- | --- |
| GET | `/health` | | `{"status": "ok"}` |
| POST | `/sessions` | `{"client": "<any name>"}` | `201 {"session": "<id>", "nonce": "<nonce>"}` |
| POST | `/sessions/verify` | `{"session": "<id>", "answer": "<answer>"}` | `200 {"verified": true}` or `403` |
| GET | `/activation` | header `X-Session: <id>` (a verified session) | `200 {"token": "<activation token>"}` |
| POST | `/shutdown` | `{}` | `202`; the server stops gracefully |

The verification answer is the first 16 hex characters of
`sha256("<session>:<nonce>")`.

The server also stops gracefully on SIGINT or SIGTERM. A server killed any
other way (SIGKILL) does not release its license and counts as a crash.
