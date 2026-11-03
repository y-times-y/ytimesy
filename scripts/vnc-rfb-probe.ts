/**
 * RFB handshake against the VNC server's Unix socket: the security types the server
 * offers. Reads exactly (the banner can arrive in pieces), retries while
 * the server is still starting, and reports a 3.3 server's single type or a
 * refusal reason, so a missing password shows up as "types=1", never as a
 * broken pipe.
 */
export const RFB_SECURITY_PY = `
import socket, struct, sys, time
def exact(s, n):
    data = b""
    while len(data) < n:
        part = s.recv(n - len(data))
        if not part:
            raise ConnectionError("closed after %d of %d bytes" % (len(data), n))
        data += part
    return data
last = "no attempt"
for attempt in range(10):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(5)
    version = b""
    try:
        s.connect(sys.argv[1])
        version = exact(s, 12)
        if not version.startswith(b"RFB "):
            raise ConnectionError("no RFB banner")
        minor = int(version[8:11])
        if minor < 7:
            s.sendall(b"RFB 003.003\\n")
            (kind,) = struct.unpack(">I", exact(s, 4))
            types = [kind]
        else:
            s.sendall(b"RFB 003.008\\n")
            count = exact(s, 1)[0]
            if count == 0:
                (size,) = struct.unpack(">I", exact(s, 4))
                raise ConnectionError("refused: " + exact(s, size).decode("utf8", "replace")[:120])
            types = list(exact(s, count))
        print("types=" + ",".join(str(t) for t in types) + " server=" + version.decode().strip())
        sys.exit(0)
    except Exception as e:
        last = "error:" + type(e).__name__ + ":" + str(e)[:120] + " banner=" + repr(version[:11])
        time.sleep(1)
    finally:
        s.close()
print(last)
`;

/** RFB security types: 1 None, 2 VNC password, 18 TLS, 19 VeNCrypt. */
export function rfbRequiresPassword(answer: string): boolean {
	const match = /^types=([\d,]+)/.exec(answer.trim());
	if (!match) return false;
	const types = match[1].split(",").map(Number);
	return (
		!types.includes(1) && types.some((t) => t === 2 || t === 18 || t === 19)
	);
}

/**
 * Full VNC password authentication over a viewer WebSocket (the edge, the
 * proxy, then the VNC server): true only when the server accepts `password`.
 * Uses noVNC's own DES (OpenSSL 3 dropped it; not in its package exports).
 */
export async function vncPasswordAuthenticates(
	url: string,
	headers: Record<string, string>,
	password: string,
) {
	const { DESECBCipher } = (await import(
		new URL("../node_modules/@novnc/novnc/core/crypto/des.js", import.meta.url)
			.href
	)) as {
		DESECBCipher: {
			importKey(key: number[]): {
				encrypt(a: unknown, x: Uint8Array): Uint8Array;
			};
		};
	};
	const { default: WebSocket } = await import("ws");
	return new Promise<boolean>((resolve) => {
		const socket = new WebSocket(url, ["binary"], { headers });
		let buffer = Buffer.alloc(0);
		let stage = 0;
		const done = (ok: boolean) => {
			clearTimeout(timer);
			socket.terminate();
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), 15_000);
		socket.on("error", () => done(false));
		socket.on("unexpected-response", () => done(false));
		socket.on("close", () => done(false));
		socket.on("message", (data: Buffer) => {
			buffer = Buffer.concat([buffer, data]);
			if (stage === 0 && buffer.length >= 12) {
				buffer = buffer.subarray(12);
				socket.send(Buffer.from("RFB 003.008\n"));
				stage = 1;
			}
			if (stage === 1 && buffer.length >= 1 && buffer.length >= 1 + buffer[0]) {
				const types = [...buffer.subarray(1, 1 + buffer[0])];
				buffer = buffer.subarray(1 + buffer[0]);
				if (!types.includes(2) || types.includes(1)) return done(false);
				socket.send(Buffer.from([2]));
				stage = 2;
			}
			if (stage === 2 && buffer.length >= 16) {
				const challenge = new Uint8Array(buffer.subarray(0, 16));
				buffer = buffer.subarray(16);
				const key = DESECBCipher.importKey(
					password.split("").map((c) => c.charCodeAt(0)),
				);
				socket.send(Buffer.from(key.encrypt({ name: "DES-ECB" }, challenge)));
				stage = 3;
			}
			if (stage === 3 && buffer.length >= 4) done(buffer.readUInt32BE(0) === 0);
		});
	});
}
