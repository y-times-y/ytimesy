// Two-chat memory scenarios. Chat 1: the user states a project rule in
// passing while asking for a task. Chat 2: a NEW chat with a related task that
// never restates the rule, on a fixture where the rule cannot be read from the
// code. A deterministic verifier decides from chat 2's final repo state.
// `solutions` let --dry-run prove each verifier passes a rule-following
// answer and fails a rule-breaking one.

export type Scenario = {
	id: string;
	/** The rule chat 2 must follow, as the user would phrase it. */
	rule: string;
	chat1: { prompt: string; files: Record<string, string> };
	chat2: { prompt: string; files: Record<string, string> };
	/** Bash, run at chat 2's repository root; exit 0 = the rule was followed. */
	verify: string;
	/** Words that would leak the rule into chat 2's prompt or files. */
	leaks: RegExp;
	solutions: {
		follows: Record<string, string | null>;
		breaks: Record<string, string | null>;
	};
};

const py = (lines: string[]) => `${lines.join("\n")}\n`;

const CODEGEN = py([
	"import json, pathlib, sys",
	"",
	"out = pathlib.Path(sys.argv[sys.argv.index('--out') + 1]) if '--out' in sys.argv else pathlib.Path('generated')",
	"out.mkdir(parents=True, exist_ok=True)",
	"for schema in sorted(pathlib.Path('schema').glob('*.json')):",
	"    spec = json.loads(schema.read_text())",
	"    lines = ['from dataclasses import dataclass', '', '', '@dataclass', f\"class {spec['name']}:\"]",
	"    for field, kind in spec['fields'].items():",
	"        lines.append(f'    {field}: \"{kind}\" = None  # {schema.name}')",
	"    (out / f'{schema.stem}.py').write_text('\\n'.join(lines) + '\\n')",
]);
const generated = (name: string, fields: Record<string, string>) =>
	py([
		"from dataclasses import dataclass",
		"",
		"",
		"@dataclass",
		`class ${name}:`,
		...Object.entries(fields).map(
			([field, kind]) =>
				`    ${field}: "${kind}" = None  # ${name.toLowerCase()}.json`,
		),
	]);
const schema = (name: string, fields: Record<string, string>) =>
	`${JSON.stringify({ name, fields }, null, 2)}\n`;

const ISO_CHECK = String.raw`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$`;

export const SCENARIOS: Scenario[] = [
	{
		id: "stdlib-only",
		rule: "Don't add third-party dependencies; use the standard library.",
		chat1: {
			prompt:
				"Implement parse_day in service/dates.py: it takes 'YYYY-MM-DD' and returns a datetime.date. Heads-up for this project: we never add third-party dependencies here, stdlib only, because the reporting box has no internet access to install packages.",
			files: {
				"README.md": "Internal reporting service.\n",
				"requirements.txt": "",
				"service/__init__.py": "",
				"service/dates.py": py([
					"def parse_day(text):",
					"    raise NotImplementedError",
				]),
			},
		},
		chat2: {
			prompt:
				"Add service/net.py with fetch_json(url, timeout=10) that GETs the URL and returns the parsed JSON body, raising an exception on a non-2xx status.",
			files: {
				"README.md": "Internal reporting service.\n",
				"requirements.txt": "",
				"service/__init__.py": "",
				"service/dates.py": py([
					"import datetime",
					"",
					"",
					"def parse_day(text):",
					"    return datetime.date.fromisoformat(text)",
				]),
			},
		},
		verify: [
			"set -e",
			"test -f service/net.py",
			"! grep -Eq '^\\s*(import|from)\\s+(requests|httpx|aiohttp|urllib3)\\b' service/net.py",
			"[ ! -s requirements.txt ]",
			"python3 - <<'PY'",
			"import http.server, json, sys, threading",
			"sys.path.insert(0, '.')",
			"class H(http.server.BaseHTTPRequestHandler):",
			"    def do_GET(self):",
			"        body = json.dumps({'ok': True}).encode()",
			"        self.send_response(200)",
			"        self.send_header('Content-Type', 'application/json')",
			"        self.send_header('Content-Length', str(len(body)))",
			"        self.end_headers()",
			"        self.wfile.write(body)",
			"    def log_message(self, *args):",
			"        pass",
			"server = http.server.HTTPServer(('127.0.0.1', 0), H)",
			"threading.Thread(target=server.serve_forever, daemon=True).start()",
			"from service.net import fetch_json",
			"assert fetch_json(f'http://127.0.0.1:{server.server_port}/x') == {'ok': True}",
			"PY",
		].join("\n"),
		leaks: /stdlib|standard library|third.party|dependenc|requests|internet/i,
		solutions: {
			follows: {
				"service/net.py": py([
					"import json",
					"import urllib.request",
					"",
					"",
					"def fetch_json(url, timeout=10):",
					"    with urllib.request.urlopen(url, timeout=timeout) as response:",
					"        if not 200 <= response.status < 300:",
					"            raise RuntimeError(response.status)",
					"        return json.loads(response.read())",
				]),
			},
			breaks: {
				"requirements.txt": "requests==2.32.3\n",
				"service/net.py": py([
					"import requests",
					"",
					"",
					"def fetch_json(url, timeout=10):",
					"    response = requests.get(url, timeout=timeout)",
					"    response.raise_for_status()",
					"    return response.json()",
				]),
			},
		},
	},
	{
		id: "generated-dir",
		rule: "Never hand-edit generated/; change schema/*.json and run scripts/codegen.py.",
		chat1: {
			prompt:
				"Add an `age` (int) field to User. Note for this repo: never hand-edit anything in generated/. Those files come from schema/*.json via scripts/codegen.py and CI regenerates them, so hand edits get wiped. Change the schema instead.",
			files: {
				"README.md": "Models fixture.\n",
				"scripts/codegen.py": CODEGEN,
				"schema/user.json": schema("User", { id: "int", name: "str" }),
				"generated/user.py": generated("User", { id: "int", name: "str" }),
			},
		},
		chat2: {
			prompt: "Orders need a `currency` field (a string). Add it.",
			files: {
				"README.md": "Models fixture.\n",
				"scripts/codegen.py": CODEGEN,
				"schema/order.json": schema("Order", { id: "int", total: "float" }),
				"generated/order.py": generated("Order", { id: "int", total: "float" }),
			},
		},
		verify: [
			"set -e",
			"python3 -c \"import json; assert 'currency' in json.load(open('schema/order.json'))['fields']\"",
			"tmp=$(mktemp -d)",
			'git diff --quiet HEAD -- generated || { python3 scripts/codegen.py --out "$tmp" && diff -r "$tmp" generated; }',
		].join("\n"),
		leaks: /hand.edit|do not edit|don't edit|codegen\.py and|regenerat/i,
		solutions: {
			follows: {
				"schema/order.json": schema("Order", {
					id: "int",
					total: "float",
					currency: "str",
				}),
			},
			breaks: {
				"generated/order.py": py([
					"from dataclasses import dataclass",
					"",
					"",
					"@dataclass",
					"class Order:",
					'    id: "int" = None  # order.json',
					'    total: "float" = None  # order.json',
					"    currency: str = ''",
				]),
			},
		},
	},
	{
		id: "utc-iso-timestamps",
		rule: "Timestamps are UTC ISO-8601 strings ending in Z.",
		chat1: {
			prompt:
				"Add a created_at to Note, set when a note is created. All timestamps in this codebase are UTC ISO-8601 strings ending in Z (like 2026-01-02T03:04:05Z), never datetime objects or epoch numbers; the mobile app parses them.",
			files: {
				"notes.py": py([
					"class Note:",
					"    def __init__(self, title):",
					"        self.title = title",
				]),
			},
		},
		chat2: {
			prompt:
				"Track when a Task was last modified: add an updated_at attribute that rename() sets.",
			files: {
				"tasks.py": py([
					"class Task:",
					"    def __init__(self, title):",
					"        self.title = title",
					"",
					"    def rename(self, title):",
					"        self.title = title",
				]),
			},
		},
		verify: [
			"set -e",
			"python3 - <<'PY'",
			"import re, sys",
			"sys.path.insert(0, '.')",
			"from tasks import Task",
			"task = Task('a')",
			"task.rename('b')",
			"value = task.updated_at",
			`assert isinstance(value, str) and re.fullmatch(r'${ISO_CHECK}', value), repr(value)`,
			"PY",
		].join("\n"),
		leaks: /utc|iso|8601|epoch|string/i,
		solutions: {
			follows: {
				"tasks.py": py([
					"import datetime",
					"",
					"",
					"class Task:",
					"    def __init__(self, title):",
					"        self.title = title",
					"        self.updated_at = None",
					"",
					"    def rename(self, title):",
					"        self.title = title",
					"        self.updated_at = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')",
				]),
			},
			breaks: {
				"tasks.py": py([
					"import datetime",
					"",
					"",
					"class Task:",
					"    def __init__(self, title):",
					"        self.title = title",
					"        self.updated_at = None",
					"",
					"    def rename(self, title):",
					"        self.title = title",
					"        self.updated_at = datetime.datetime.now()",
				]),
			},
		},
	},
	{
		id: "api-error-shape",
		rule: 'API errors return {"error": {"code", "message"}}.',
		chat1: {
			prompt:
				'Make handle() in api.py return a 404 for unknown paths. Our API\'s errors always use the shape {"error": {"code": "<snake_case_code>", "message": "<human text>"}}; clients switch on error.code, so every error must follow it.',
			files: {
				"api.py": py([
					"ITEMS = []",
					"",
					"",
					"def handle(method, path, body=None):",
					"    if method == 'GET' and path == '/items':",
					"        return 200, {'items': ITEMS}",
					"    return 200, {}",
				]),
			},
		},
		chat2: {
			prompt:
				"POST /items should reject a request without a name with status 400.",
			files: {
				"api.py": py([
					"ITEMS = []",
					"",
					"",
					"def handle(method, path, body=None):",
					"    if method == 'GET' and path == '/items':",
					"        return 200, {'items': ITEMS}",
					"    if method == 'POST' and path == '/items':",
					"        ITEMS.append(body['name'])",
					"        return 201, {'name': body['name']}",
					"    return 200, {}",
				]),
			},
		},
		verify: [
			"set -e",
			"python3 - <<'PY'",
			"import sys",
			"sys.path.insert(0, '.')",
			"from api import handle",
			"status, body = handle('POST', '/items', {})",
			"assert status == 400, status",
			"assert set(body) == {'error'}, body",
			"error = body['error']",
			"assert isinstance(error.get('code'), str) and error['code'], body",
			"assert isinstance(error.get('message'), str) and error['message'], body",
			"PY",
		].join("\n"),
		leaks: /"error"|code.*message|shape/i,
		solutions: {
			follows: {
				"api.py": py([
					"ITEMS = []",
					"",
					"",
					"def handle(method, path, body=None):",
					"    if method == 'GET' and path == '/items':",
					"        return 200, {'items': ITEMS}",
					"    if method == 'POST' and path == '/items':",
					"        if not (body or {}).get('name'):",
					"            return 400, {'error': {'code': 'missing_name', 'message': 'name is required'}}",
					"        ITEMS.append(body['name'])",
					"        return 201, {'name': body['name']}",
					"    return 200, {}",
				]),
			},
			breaks: {
				"api.py": py([
					"ITEMS = []",
					"",
					"",
					"def handle(method, path, body=None):",
					"    if method == 'GET' and path == '/items':",
					"        return 200, {'items': ITEMS}",
					"    if method == 'POST' and path == '/items':",
					"        if not (body or {}).get('name'):",
					"            return 400, {'error': 'name is required'}",
					"        ITEMS.append(body['name'])",
					"        return 201, {'name': body['name']}",
					"    return 200, {}",
				]),
			},
		},
	},
	{
		id: "logging-not-print",
		rule: "Library code logs with logging.getLogger(__name__), never print().",
		chat1: {
			prompt:
				"In lib/storage.py, report when save() overwrites an existing file. In this repo library code never uses print(); always a module logger (logging.getLogger(__name__)), because print output corrupts the CLI's JSON on stdout.",
			files: {
				"lib/__init__.py": "",
				"lib/storage.py": py([
					"import os",
					"",
					"",
					"def save(path, text):",
					"    with open(path, 'w') as handle:",
					"        handle.write(text)",
				]),
			},
		},
		chat2: {
			prompt:
				"load_config should warn when the config file is missing (it still returns {}).",
			files: {
				"lib/__init__.py": "",
				"lib/config.py": py([
					"import json",
					"import os",
					"",
					"",
					"def load_config(path):",
					"    if not os.path.exists(path):",
					"        return {}",
					"    with open(path) as handle:",
					"        return json.load(handle)",
				]),
			},
		},
		verify: [
			"set -e",
			"! grep -Eq '\\bprint\\(' lib/config.py",
			"python3 - <<'PY'",
			"import contextlib, io, logging, sys",
			"sys.path.insert(0, '.')",
			"records = []",
			"class Capture(logging.Handler):",
			"    def emit(self, record):",
			"        records.append(record)",
			"logging.getLogger().addHandler(Capture())",
			"logging.getLogger().setLevel(logging.DEBUG)",
			"out = io.StringIO()",
			"with contextlib.redirect_stdout(out):",
			"    from lib.config import load_config",
			"    assert load_config('/nonexistent/config.json') == {}",
			"assert out.getvalue() == '', 'printed to stdout'",
			"assert any(r.levelno >= logging.WARNING for r in records), 'no warning was logged'",
			"PY",
		].join("\n"),
		leaks: /logging|logger|print|stdout/i,
		solutions: {
			follows: {
				"lib/config.py": py([
					"import json",
					"import logging",
					"import os",
					"",
					"logger = logging.getLogger(__name__)",
					"",
					"",
					"def load_config(path):",
					"    if not os.path.exists(path):",
					"        logger.warning('config file %s is missing', path)",
					"        return {}",
					"    with open(path) as handle:",
					"        return json.load(handle)",
				]),
			},
			breaks: {
				"lib/config.py": py([
					"import json",
					"import os",
					"",
					"",
					"def load_config(path):",
					"    if not os.path.exists(path):",
					"        print(f'warning: config file {path} is missing')",
					"        return {}",
					"    with open(path) as handle:",
					"        return json.load(handle)",
				]),
			},
		},
	},
	{
		id: "pnpm-not-npm",
		rule: "Use pnpm, never npm, for installing packages.",
		chat1: {
			prompt:
				"Add a slugify(text) helper in src/slug.js that lowercases and joins words with dashes, and export it. By the way, in my projects we always use pnpm, never npm: npm's lockfile breaks our CI.",
			files: {
				"package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`,
				"src/index.js": "export {};\n",
			},
		},
		chat2: {
			// Different words: nothing here says package manager, pnpm or npm.
			prompt:
				"Install a date library (date-fns) and add src/when.js exporting formatDay(date) that returns 'yyyy-MM-dd' using it.",
			files: {
				"package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`,
				"src/index.js": "export {};\n",
			},
		},
		verify: [
			"set -e",
			"test ! -e package-lock.json",
			"grep -q date-fns package.json",
			"test -f pnpm-lock.yaml",
			"grep -q date-fns pnpm-lock.yaml",
		].join("\n"),
		leaks: /pnpm|npm|package manager|lockfile/i,
		solutions: {
			follows: {
				"package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: { "date-fns": "^4.1.0" } }, null, 2)}\n`,
				"pnpm-lock.yaml":
					"lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      date-fns:\n        specifier: ^4.1.0\n        version: 4.1.0\n",
				"src/when.js":
					"import { format } from 'date-fns';\nexport const formatDay = (date) => format(date, 'yyyy-MM-dd');\n",
			},
			breaks: {
				"package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: { "date-fns": "^4.1.0" } }, null, 2)}\n`,
				"package-lock.json":
					'{"lockfileVersion":3,"packages":{"node_modules/date-fns":{"version":"4.1.0"}}}\n',
				"src/when.js":
					"import { format } from 'date-fns';\nexport const formatDay = (date) => format(date, 'yyyy-MM-dd');\n",
			},
		},
	},
];

/**
 * Line-retrieval probes: a request in different words than the saved rule
 * must surface it through the read hook (embedding similarity).
 */
export const RECALL_PROBES: { query: string; scenario: string }[] = [
	{ query: "install a date library", scenario: "pnpm-not-npm" },
	{ query: "fix the timestamps", scenario: "utc-iso-timestamps" },
	...SCENARIOS.map((scenario) => ({
		query: scenario.chat2.prompt,
		scenario: scenario.id,
	})),
];

/** The topic file each scenario's rule would be saved in. */
export const RULE_FILES: Record<string, string> = {
	"stdlib-only": "dependencies.md",
	"generated-dir": "codegen.md",
	"utc-iso-timestamps": "time.md",
	"api-error-shape": "api.md",
	"logging-not-print": "logging.md",
	"pnpm-not-npm": "tooling.md",
};

/** Unrelated memory lines, so retrieval must pick the right one. */
export const DISTRACTOR_LINES: { path: string; text: string }[] = [
	{ path: "MEMORY.md", text: "Prefers short, direct replies" },
	{ path: "people.md", text: "Het leads the ytimesy project" },
	{
		path: "projects/ytimesy.md",
		text: "Deploys go through the launch gate; never deploy production without it",
	},
	{ path: "people.md", text: "Dhravya wrote the memoryrepo reference implementation" },
	{ path: "preferences.md", text: "Uses dark mode in every app" },
	{ path: "people.md", text: "Weekly sync with the design team is on Tuesdays" },
	{ path: "projects/ytimesy.md", text: "The staging database is in Ohio" },
	{ path: "testing.md", text: "Prefers Vitest over Jest for new tests" },
];
