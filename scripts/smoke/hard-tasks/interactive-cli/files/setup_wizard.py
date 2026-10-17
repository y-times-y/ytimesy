"""Interactive setup for this checkout: writes and signs config/app.json.

    python3 setup_wizard.py

The wizard takes no options and must be run in a terminal: answers are
confirmed against codes it shows on screen, and the menu order differs on
every run, so answers cannot be scripted in advance.
"""
import hashlib
import hmac
import json
import os
import random
import string
import sys
import time

SIGNING_KEY = b"setup-wizard-dev-signing-key"
REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-west-2", "ap-south-1"]
ENVIRONMENTS = ["staging", "production", "sandbox", "qa"]
HERE = os.path.dirname(os.path.abspath(__file__))


def ask(question, check, attempts=3):
    for _ in range(attempts):
        sys.stdout.write(question)
        sys.stdout.flush()
        line = sys.stdin.readline()
        if not line:
            sys.exit("\nsetup aborted: input closed")
        value = check(line.strip())
        if value is not None:
            return value
        print("  invalid answer, try again")
    sys.exit("setup aborted: too many invalid answers")


def main():
    if len(sys.argv) > 1:
        sys.exit("setup_wizard.py takes no options; run it and answer the questions.")
    if not sys.stdin.isatty():
        sys.exit("setup_wizard.py must be run interactively in a terminal (stdin is not a TTY).")
    rng = random.SystemRandom()
    print("== Checkout setup ==")
    time.sleep(0.5)

    order = ENVIRONMENTS[:]
    rng.shuffle(order)
    print("Environments:")
    for number, name in enumerate(order, 1):
        print(f"  [{number}] {name}")
    environment = ask(
        f"Select environment [1-{len(order)}]: ",
        lambda a: order[int(a) - 1] if a.isdigit() and 1 <= int(a) <= len(order) else None,
    )

    region = ask(
        f"Region ({', '.join(REGIONS)}): ",
        lambda a: a if a in REGIONS else None,
    )

    telemetry = ask(
        "Enable anonymous telemetry? [y/N]: ",
        lambda a: {"y": True, "yes": True, "n": False, "no": False, "": False}.get(a.lower()),
    )

    email = ask(
        "Admin email: ",
        lambda a: a if "@" in a and "." in a.split("@")[-1] and " " not in a else None,
    )

    code = "".join(rng.choice(string.ascii_uppercase) for _ in range(4))
    print(f"\nAbout to write config/app.json for {environment} / {region}.")
    print(f"Confirmation code: {code}")
    ask("Type the confirmation code to continue: ", lambda a: a if a == code else None, attempts=1)

    install_id = "".join(rng.choice("0123456789abcdef") for _ in range(16))
    config = {
        "environment": environment,
        "region": region,
        "telemetry": telemetry,
        "admin_email": email,
        "install_id": install_id,
    }
    canonical = json.dumps(config, sort_keys=True).encode()
    config["signature"] = hmac.new(SIGNING_KEY + code.encode(), canonical, hashlib.sha256).hexdigest()
    config["confirmation"] = hashlib.sha256((install_id + code).encode()).hexdigest()[:12]
    os.makedirs(os.path.join(HERE, "config"), exist_ok=True)
    with open(os.path.join(HERE, "config", "app.json"), "w") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    with open(os.path.join(HERE, ".setup-receipt"), "w") as handle:
        handle.write(code + "\n")
    print("Wrote config/app.json. Setup complete.")


if __name__ == "__main__":
    main()
