"""Fixed-destination opaque TCP proxy: admits only `CONNECT chatgpt.com:443`.

Each CONNECT carries an expiring, single-use credential the Workers make
(src/server/adapters/codex-tunnel.ts) as the proxy password of user `ytimesy`:

- `e1.<expires ms>.<nonce>.<signature>`: Ed25519 over
  `e1.<expires>.<nonce>.chatgpt.com:443`, checked with the Workers' public key
  (base64 SPKI DER) in CODEX_PROXY_PUBLIC_KEY_FILE. Needs python3-cryptography,
  which Ubuntu 24.04 cloud images ship. No secret lives on this box.
- `<expires ms>.<nonce>.<HMAC-SHA256 hex>`: the legacy form, checked only while
  the shared secret file CODEX_PROXY_SECRET_FILE exists (rollout only).

A form is accepted when its key file exists. No model credentials terminate
here: the bytes behind the CONNECT are TLS between the Worker and ChatGPT.
"""
import asyncio
import base64
import hashlib
import hmac
import os
import re
import sys
import time

TARGET = "chatgpt.com:443"
EXPIRES = re.compile(r"[0-9]{13}")
NONCE = re.compile(r"[0-9a-f]{32}")
SIGNATURE = re.compile(r"[0-9a-f]{128}")
# sysexits EX_CONFIG: the unit does not restart on it (RestartPreventExitStatus).
EX_CONFIG = 78
SEEN = {}
SLOTS = asyncio.Semaphore(128)


class Keys:
    """The verification keys this proxy has: an Ed25519 public key, the legacy secret, or both."""

    def __init__(self, public_key=None, secret=None):
        self.public_key = public_key
        self.secret = secret

    def forms(self):
        return [name for name, key in (("ed25519", self.public_key), ("hmac", self.secret)) if key]

    def verify_ed25519(self, signature, message):
        if not self.public_key or not SIGNATURE.fullmatch(signature):
            return False
        from cryptography.exceptions import InvalidSignature

        try:
            self.public_key.verify(bytes.fromhex(signature), message.encode())
            return True
        except InvalidSignature:
            return False

    def verify_hmac(self, signature, message):
        if not self.secret:
            return False
        expected = hmac.new(self.secret.encode(), message.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)


def ed25519_public_key(text):
    """The Workers' public key from its base64 SPKI DER (scripts/generate-codex-tunnel-keypair.ts prints it)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    key = load_der_public_key(base64.b64decode(text.strip(), validate=True))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("The Codex proxy public key is not an Ed25519 key.")
    return key


def authorize(header, keys, seen=SEEN, now=None):
    """Whether a Proxy-Authorization header admits one CONNECT; spends its nonce if so."""
    try:
        now = time.time() if now is None else now
        credentials = base64.b64decode(header.removeprefix("Basic "), validate=True).decode("ascii")
        user, token = credentials.split(":", 1)
        parts = token.split(".")
        if user != "ytimesy":
            return False
        if len(parts) == 4 and parts[0] == "e1":
            _, expires, nonce, signature = parts
            check = keys.verify_ed25519
            message = f"e1.{expires}.{nonce}.{TARGET}"
        elif len(parts) == 3:
            expires, nonce, signature = parts
            check = keys.verify_hmac
            message = f"{expires}.{nonce}.{TARGET}"
        else:
            return False
        if not EXPIRES.fullmatch(expires) or not now < int(expires) / 1000 <= now + 65:
            return False
        if not NONCE.fullmatch(nonce) or nonce in seen:
            return False
        if not check(signature, message):
            return False
        for key, expiry in list(seen.items()):
            if expiry <= now:
                del seen[key]
        seen[nonce] = int(expires) / 1000
        return True
    except (ValueError, UnicodeError):
        return False


def log(message):
    print(message, file=sys.stderr, flush=True)


def load_keys(environ):
    """The keys whose files exist; exits with EX_CONFIG (no restart loop) when none is usable."""
    public_key = None
    secret = None
    public_path = environ.get("CODEX_PROXY_PUBLIC_KEY_FILE")
    if public_path and os.path.exists(public_path):
        try:
            import cryptography  # noqa: F401
        except ImportError:
            log(
                f"Codex proxy refuses to start: {public_path} holds an Ed25519 public key but the Python "
                "'cryptography' package is missing (apt-get install python3-cryptography)."
            )
            sys.exit(EX_CONFIG)
        try:
            with open(public_path, encoding="ascii") as file:
                public_key = ed25519_public_key(file.read())
        except (ValueError, UnicodeError) as error:
            log(f"Codex proxy refuses to start: {public_path} is not a base64 SPKI Ed25519 public key ({error}).")
            sys.exit(EX_CONFIG)
    secret_path = environ.get("CODEX_PROXY_SECRET_FILE")
    if secret_path and os.path.exists(secret_path):
        with open(secret_path, encoding="ascii") as file:
            secret = file.read().strip()
        if len(secret) < 64:
            log(f"Codex proxy refuses to start: the shared secret in {secret_path} is shorter than 64 characters.")
            sys.exit(EX_CONFIG)
    keys = Keys(public_key, secret)
    if not keys.forms():
        log("Codex proxy refuses to start: neither CODEX_PROXY_PUBLIC_KEY_FILE nor CODEX_PROXY_SECRET_FILE names an existing file.")
        sys.exit(EX_CONFIG)
    return keys


async def handle(reader, writer, keys):
    upstream = None
    tasks = []
    try:
        async with SLOTS:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = head.decode("ascii").split("\r\n")
            auth = [line.split(":", 1)[1].strip() for line in lines[1:] if line.lower().startswith("proxy-authorization:")]
            if lines[0] != f"CONNECT {TARGET} HTTP/1.1" or len(auth) != 1 or not authorize(auth[0], keys):
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


async def main(keys):
    port = int(os.environ.get("PORT", "18080"))
    # Both families: a lone "::" socket is IPv6-only here, which refused the
    # Workers' IPv4 connections (docs/research/codex-tunnel-production-2026-11-07.md).
    server = await asyncio.start_server(
        lambda reader, writer: handle(reader, writer, keys), ["0.0.0.0", "::"], port, limit=8192
    )
    log(f"Codex proxy on port {port} verifies: {', '.join(keys.forms())}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main(load_keys(os.environ)))
