git diff --quiet HEAD -- setup_wizard.py || { echo "setup_wizard.py was modified"; exit 1; }
test -f config/app.json || { echo "config/app.json is missing"; exit 1; }
test -f .setup-receipt || { echo "the wizard never completed"; exit 1; }
python3 - <<'PY'
import hashlib, hmac, json, sys
config = json.load(open("config/app.json"))
code = open(".setup-receipt").read().strip()
want = {"environment": "staging", "region": "eu-west-2", "telemetry": False, "admin_email": "ops@example.com"}
for key, value in want.items():
    if config.get(key) != value:
        sys.exit(f"{key} is {config.get(key)!r}, expected {value!r}")
body = {k: config[k] for k in ("environment", "region", "telemetry", "admin_email", "install_id")}
signature = hmac.new(b"setup-wizard-dev-signing-key" + code.encode(), json.dumps(body, sort_keys=True).encode(), hashlib.sha256).hexdigest()
if config.get("signature") != signature or config.get("confirmation") != hashlib.sha256((config["install_id"] + code).encode()).hexdigest()[:12]:
    sys.exit("config/app.json is not the wizard's signed output")
print("config written and signed by the wizard")
PY
