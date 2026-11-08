"""Fixed-destination opaque TCP proxy. Run with a private CODEX_PROXY_SECRET_FILE.

The secret file must contain 32+ random bytes as a hexadecimal string. Clients
supply expiring, single-use HMAC credentials; no model credentials terminate here.
"""
import asyncio
import base64
import hashlib
import hmac
import os
import time

SECRET = open(os.environ["CODEX_PROXY_SECRET_FILE"], encoding="ascii").read().strip()
if len(SECRET) < 64:
    raise RuntimeError("Proxy signing key is invalid")
SEEN = {}
SLOTS = asyncio.Semaphore(128)


def authorize(header):
    try:
        credentials = base64.b64decode(header.removeprefix("Basic "), validate=True).decode("ascii")
        user, token = credentials.split(":", 1)
        expires, nonce, signature = token.split(".")
        now = time.time()
        if user != "ytimesy" or not now < int(expires) / 1000 <= now + 65:
            return False
        if len(nonce) != 32 or nonce in SEEN:
            return False
        expected = hmac.new(SECRET.encode(), f"{expires}.{nonce}.chatgpt.com:443".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return False
        for key, expiry in list(SEEN.items()):
            if expiry <= now:
                del SEEN[key]
        SEEN[nonce] = int(expires) / 1000
        return True
    except (ValueError, UnicodeError):
        return False


async def handle(reader, writer):
    upstream = None
    tasks = []
    try:
        async with SLOTS:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = head.decode("ascii").split("\r\n")
            auth = [line.split(":", 1)[1].strip() for line in lines[1:] if line.lower().startswith("proxy-authorization:")]
            if lines[0] != "CONNECT chatgpt.com:443 HTTP/1.1" or len(auth) != 1 or not authorize(auth[0]):
                writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                await writer.drain()
                return
            remote, upstream = await asyncio.wait_for(asyncio.open_connection("chatgpt.com", 443), 10)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()

            async def pump(source, target):
                while chunk := await source.read(65536):
                    target.write(chunk)
                    await target.drain()

            tasks = [asyncio.create_task(pump(reader, upstream)), asyncio.create_task(pump(remote, writer))]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (Exception, asyncio.CancelledError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if upstream:
            upstream.close()
        writer.close()
        await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle, "::", int(os.environ.get("PORT", "18080")), limit=8192)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
