/**
 * RFB handshake against x11vnc's Unix socket: the security types the server
 * offers. Reads exactly (the banner can arrive in pieces), retries while
 * x11vnc is still starting, and reports a 3.3 server's single type or a
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
