#!/usr/bin/env python3
import os
import pty
import select
import sys


def main() -> int:
	if "--" not in sys.argv:
		sys.stderr.write("usage: turn-pty.py OUT ERR -- CMD [ARG...]\n")
		return 2
	sep = sys.argv.index("--")
	if sep < 3 or sep + 1 >= len(sys.argv):
		sys.stderr.write("usage: turn-pty.py OUT ERR -- CMD [ARG...]\n")
		return 2
	out_path, err_path = sys.argv[1], sys.argv[2]
	argv = sys.argv[sep + 1 :]
	out = open(out_path, "wb", buffering=0)
	pid, fd = pty.fork()
	if pid == 0:
		err_fd = os.open(err_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
		os.dup2(err_fd, 2)
		os.close(err_fd)
		os.execvp(argv[0], argv)
	try:
		while True:
			ready, _, _ = select.select([fd], [], [], 0.2)
			if ready:
				try:
					chunk = os.read(fd, 4096)
				except OSError:
					break
				if not chunk:
					break
				out.write(chunk)
				continue
			waited = os.waitpid(pid, os.WNOHANG)
			if waited[0] == pid:
				return wait_status(waited[1])
		waited = os.waitpid(pid, 0)
		return wait_status(waited[1])
	finally:
		out.close()
		try:
			os.close(fd)
		except OSError:
			pass


def wait_status(status: int) -> int:
	if os.WIFEXITED(status):
		return os.WEXITSTATUS(status)
	if os.WIFSIGNALED(status):
		return 128 + os.WTERMSIG(status)
	return 1


if __name__ == "__main__":
	raise SystemExit(main())
