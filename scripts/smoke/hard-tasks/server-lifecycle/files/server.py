"""Licensing service (development build).

    python3 server.py [--port PORT]      default port 8790

Serves the API described in API.md until it receives SIGINT, SIGTERM or
POST /shutdown. Each start issues a fresh activation token; only a running
server knows it.
"""
import argparse
import hashlib
import json
import os
import secrets
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lifecycle")


def log_event(*parts):
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, "events"), "a") as handle:
        handle.write(" ".join(str(part) for part in parts) + "\n")


class Service:
    def __init__(self):
        self.token = secrets.token_hex(12)
        self.sessions = {}
        self.lock = threading.Lock()

    def open_session(self, client):
        session = secrets.token_hex(6)
        with self.lock:
            self.sessions[session] = {"client": client, "verified": False, "nonce": secrets.token_hex(4)}
        return session, self.sessions[session]["nonce"]

    def verify(self, session, answer):
        with self.lock:
            entry = self.sessions.get(session)
            if not entry:
                return False
            expected = hashlib.sha256(f"{session}:{entry['nonce']}".encode()).hexdigest()[:16]
            entry["verified"] = answer == expected
            return entry["verified"]

    def token_for(self, session):
        with self.lock:
            entry = self.sessions.get(session)
            return self.token if entry and entry["verified"] else None


def make_handler(service, stop):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return None

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"status": "ok"})
            if self.path == "/activation":
                session = self.headers.get("X-Session", "")
                token = service.token_for(session)
                if token is None:
                    return self.reply(403, {"error": "unknown or unverified session"})
                return self.reply(200, {"token": token})
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            payload = self.body()
            if payload is None:
                return self.reply(400, {"error": "body must be JSON"})
            if self.path == "/sessions":
                client = payload.get("client")
                if not client:
                    return self.reply(400, {"error": "client is required"})
                session, nonce = service.open_session(client)
                return self.reply(201, {"session": session, "nonce": nonce})
            if self.path == "/sessions/verify":
                if service.verify(payload.get("session", ""), payload.get("answer", "")):
                    return self.reply(200, {"verified": True})
                return self.reply(403, {"verified": False})
            if self.path == "/shutdown":
                self.reply(202, {"stopping": True})
                threading.Thread(target=stop, daemon=True).start()
                return
            self.reply(404, {"error": "not found"})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    print("licensing service: loading license index ...", flush=True)
    for step in range(1, 6):
        time.sleep(1)
        print(f"  index shard {step}/5 loaded", flush=True)
    service = Service()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(service, lambda: None))
    stopped = threading.Event()

    def stop(*_):
        if not stopped.is_set():
            stopped.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    server.RequestHandlerClass = make_handler(service, stop)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log_event("start", os.getpid(), args.port, hashlib.sha256(service.token.encode()).hexdigest())
    print(f"licensing service listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        log_event("clean-stop", os.getpid())
        print("licensing service stopped", flush=True)


if __name__ == "__main__":
    main()
