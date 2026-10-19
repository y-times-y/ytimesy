"""Command line: python3 -m app.cli <command> <text>."""

import sys

import utils.textfmt as tf
from app.registry import apply


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command, text = argv[0], " ".join(argv[1:])
    if command == "slug":
        print(tf.slugify(text))
    elif command == "title":
        print(tf.title_case(text))
    elif command == "short":
        print(tf.truncate(text, 20))
    else:
        print(apply(command, text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
