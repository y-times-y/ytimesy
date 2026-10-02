"""Session-scoped mailbox shared by API safe points and unmodified Claude hooks."""
import json
import os
import sys
import fcntl


def pending(root, recipient_id=None):
    if not os.path.isdir(root):
        return []
    messages = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        with open(path, encoding="utf-8") as handle:
            message = json.load(handle)
        if recipient_id and message.get("recipientId") != recipient_id:
            continue
        if not os.path.exists(path + ".accepted"):
            messages.append(message)
    return messages


def acknowledge(root, ids):
    for message_id in ids:
        if not message_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-" for c in message_id):
            raise ValueError("Invalid mailbox identity")
        with open(os.path.join(root, message_id + ".json.accepted"), "w", encoding="utf-8") as handle:
            handle.write("accepted\n")


def main():
    root = sys.argv[1]
    mode = sys.argv[2]
    if mode == "peek":
        print(json.dumps(pending(root, sys.argv[3] if len(sys.argv) > 3 else None)))
    elif mode == "ack":
        acknowledge(root, sys.argv[3:])
    elif mode == "hook":
        event = json.load(sys.stdin).get("hook_event_name")
        if event not in ("PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop"):
            return
        os.makedirs(root, exist_ok=True)
        # Parallel tool hooks must not consume the same message twice.
        with open(os.path.join(root, ".lock"), "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            messages = pending(root, sys.argv[3] if len(sys.argv) > 3 else None)[:1]
            if messages:
                print(json.dumps({"hookSpecificOutput": {
                    "hookEventName": event,
                    "additionalContext": "\n\n".join(message["text"] for message in messages),
                }}), flush=True)
                acknowledge(root, [message["id"] for message in messages])


if __name__ == "__main__":
    main()
