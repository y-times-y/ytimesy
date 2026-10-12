#!/usr/bin/env python3
"""Shell access to the task's MCP servers (installed in the task container).

  mcp-call <server> list
  mcp-call <server> call <tool> '<json arguments>'

One background session per server keeps server-side state (for example an open
browser page) between calls. Servers come from /etc/ytimesy-mcp.json, written
from Harbor's task configuration. Transports: sse and streamable-http.
"""
import json, os, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin

CONFIG = os.environ.get("YTIMESY_MCP_CONFIG", "/etc/ytimesy-mcp.json")
INIT = {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "ytimesy", "version": "1"}}


def servers():
    return {s["name"]: s for s in json.load(open(CONFIG))}


class SseSession:
    def __init__(self, url):
        self.replies, self.cond, self.post_url, self.next_id = {}, threading.Condition(), None, 1
        stream = urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "text/event-stream"}))
        threading.Thread(target=self._read, args=(stream, url), daemon=True).start()
        with self.cond:
            self.cond.wait_for(lambda: self.post_url, timeout=60)

    def _read(self, stream, url):
        event, data = "message", []
        for raw in stream:
            line = raw.decode().rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
            elif not line and data:
                payload = "\n".join(data)
                with self.cond:
                    if event == "endpoint":
                        self.post_url = urljoin(url, payload)
                    else:
                        message = json.loads(payload)
                        if "id" in message:
                            self.replies[message["id"]] = message
                    self.cond.notify_all()
                event, data = "message", []

    def send(self, method, params, notify=False):
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            with self.cond:
                body["id"] = self.next_id
                self.next_id += 1
        request = urllib.request.Request(self.post_url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        urllib.request.urlopen(request).read()
        if notify:
            return None
        with self.cond:
            self.cond.wait_for(lambda: body["id"] in self.replies, timeout=600)
            return self.replies.pop(body["id"], {"error": "no reply within 600s"})


class HttpSession:
    def __init__(self, url):
        self.url, self.session, self.next_id = url, None, 1

    def send(self, method, params, notify=False):
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            body["id"] = self.next_id
            self.next_id += 1
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        response = urllib.request.urlopen(urllib.request.Request(self.url, json.dumps(body).encode(), headers), timeout=600)
        self.session = response.headers.get("Mcp-Session-Id") or self.session
        text = response.read().decode()
        if notify or not text.strip():
            return None
        if "text/event-stream" in (response.headers.get("Content-Type") or ""):
            for line in text.splitlines():
                if line.startswith("data:"):
                    message = json.loads(line[5:])
                    if message.get("id") == body["id"]:
                        return message
        return json.loads(text)


def serve(name):
    server = servers()[name]
    session = (SseSession if server.get("transport", "sse") == "sse" else HttpSession)(server["url"])
    session.send("initialize", INIT)
    session.send("notifications/initialized", {}, notify=True)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                reply = session.send(request["method"], request["params"])
            body = json.dumps(reply).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    open(f"/tmp/mcp-{name}.port", "w").write(str(httpd.server_address[1]))
    httpd.serve_forever()


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--serve":
        return serve(sys.argv[2])
    if len(sys.argv) < 3 or sys.argv[2] not in ("list", "call"):
        print(__doc__.strip())
        print("servers:", ", ".join(servers()))
        return 2
    name = sys.argv[1]
    if name not in servers():
        print(f"unknown server {name}; servers: {', '.join(servers())}")
        return 2
    port_file = f"/tmp/mcp-{name}.port"
    if not os.path.exists(port_file):
        log = open(f"/tmp/mcp-{name}.log", "a")
        subprocess.Popen([sys.executable, __file__, "--serve", name], stdout=log, stderr=log, start_new_session=True)
        for _ in range(120):
            if os.path.exists(port_file):
                break
            time.sleep(0.5)
        else:
            print(open(f"/tmp/mcp-{name}.log").read()[-2000:] or "MCP session did not start")
            return 1
    if sys.argv[2] == "list":
        method, params = "tools/list", {}
    else:
        method, params = "tools/call", {"name": sys.argv[3], "arguments": json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}}
    port = open(port_file).read()
    request = urllib.request.Request(f"http://127.0.0.1:{port}", json.dumps({"method": method, "params": params}).encode())
    reply = json.loads(urllib.request.urlopen(request, timeout=900).read())
    result = reply.get("result", reply) if reply else {}
    if method == "tools/list":
        for tool in result.get("tools", []):
            print(f"{tool['name']}: {tool.get('description', '').strip()}\n  arguments: {json.dumps(tool.get('inputSchema', {}).get('properties', {}))}")
    else:
        for item in result.get("content", []) if isinstance(result, dict) else []:
            print(item.get("text") if item.get("type") == "text" else f"[{item.get('type')} content]")
        if not isinstance(result, dict) or "content" not in result:
            print(json.dumps(result))
    return 0


sys.exit(main())
