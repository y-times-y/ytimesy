import { describe, expect, it } from "vitest";
import {
	commandOutputTones,
	genericTone,
	literalPattern,
	shellSegments,
	type TonedLine,
} from "./command-output-tone";

/** A line as `<tone>text</>` spans, prefixed with `[tone] ` for a whole-line tone. */
const render = (line: TonedLine) =>
	(line.tone ? `[${line.tone}] ` : "") +
	line.spans
		.map((span) => (span.tone ? `<${span.tone}>${span.text}</>` : span.text))
		.join("");

const toned = (command: string, output: string) =>
	commandOutputTones(command, output).lines.map(render);

describe("search output", () => {
	it("colours paths, mutes line and column numbers and marks a literal term", () => {
		expect(
			toned(
				"rg -n useState src",
				"src/a.tsx:12:5:const [x] = useState(0);\nsrc/b.ts:3:import { useState } from 'react';",
			),
		).toEqual([
			"<path>src/a.tsx</><muted>:12:5:</>const [x] = <match>useState</>(0);",
			"<path>src/b.ts</><muted>:3:</>import { <match>useState</> } from 'react';",
		]);
	});

	it("reads rg's grouped heading format and context lines", () => {
		expect(
			toned(
				"rg --heading -C1 'retry' src",
				"src/jobs/run.ts\n10-function go() {\n11:  retry();\n--\nsrc/a.ts\n4:retry",
			),
		).toEqual([
			"[path] src/jobs/run.ts",
			"[muted] <muted>10-</>function go() {",
			"<muted>11:</>  <match>retry</>();",
			"[muted] --",
			"[path] src/a.ts",
			"<muted>4:</><match>retry</>",
		]);
	});

	it("handles git grep and grep -rn", () => {
		expect(toned("git grep -n TODO", "src/a.ts:7:// TODO tidy")).toEqual([
			"<path>src/a.ts</><muted>:7:</>// <match>TODO</> tidy",
		]);
		expect(toned("grep -rni 'todo' .", "./src/a.ts:7:// TODO tidy")).toEqual([
			"<path>./src/a.ts</><muted>:7:</>// <match>TODO</> tidy",
		]);
	});

	it("skips match marks when the pattern is a regex", () => {
		expect(
			toned("rg -n 'use(State|Effect)' src", "src/a.ts:1:useState"),
		).toEqual(["<path>src/a.ts</><muted>:1:</>useState"]);
	});

	it("marks hits in piped grep output without paths", () => {
		expect(
			toned("cat log.txt | grep timeout", "request timeout after 3s"),
		).toEqual(["request <match>timeout</> after 3s"]);
	});

	it("colours file lists from -l and --files", () => {
		expect(toned("rg -l foo", "src/a.ts\nsrc/b.ts")).toEqual([
			"[path] src/a.ts",
			"[path] src/b.ts",
		]);
		expect(toned("rg --files src", "src/a.ts")).toEqual(["[path] src/a.ts"]);
		expect(toned("rg -c foo", "src/a.ts:3")).toEqual([
			"<path>src/a.ts</><muted>:3</>",
		]);
	});

	it("extracts only plain literal patterns", () => {
		expect(literalPattern("useState", false)).toBe("useState");
		expect(literalPattern("a\\.b", false)).toBe("a.b");
		expect(literalPattern("a.b", false)).toBeNull();
		expect(literalPattern("\\bfoo", false)).toBeNull();
		expect(literalPattern("a.b", true)).toBe("a.b");
		expect(literalPattern("x", false)).toBeNull();
	});

	it("honours smart case and -e", () => {
		expect(toned("rg -S -n retry", "a.ts:1:Retry")).toEqual([
			"<path>a.ts</><muted>:1:</><match>Retry</>",
		]);
		expect(toned("grep -n -e Retry a.ts", "1:retry Retry")).toEqual([
			"<muted>1:</>retry <match>Retry</>",
		]);
	});
});

describe("test runner output", () => {
	it("colours vitest passes, failures, skips and the summary", () => {
		expect(
			toned(
				"npx vitest run",
				[
					" ✓ src/a.test.ts (3 tests) 12ms",
					" ❯ src/b.test.ts (2 tests | 1 failed) 8ms",
					"   × adds numbers 3ms",
					"   ↓ later [skipped]",
					" FAIL  src/b.test.ts > adds numbers",
					" Test Files  1 failed | 1 passed (2)",
					"      Tests  1 failed | 4 passed | 1 skipped (6)",
				].join("\n"),
			),
		).toEqual([
			"[good]  ✓ <path>src/a.test.ts</> (3 tests) <muted>12ms</>",
			" ❯ <path>src/b.test.ts</> (2 tests | <bad>1 failed</>) 8ms",
			"[bad]    × adds numbers <muted>3ms</>",
			"[muted]    ↓ later [skipped]",
			"[bad]  FAIL  <path>src/b.test.ts</> > adds numbers",
			" Test Files  <bad>1 failed</> | <good>1 passed</> (2)",
			"      Tests  <bad>1 failed</> | <good>4 passed</> | <muted>1 skipped</> (6)",
		]);
	});

	it("colours jest, pytest, go and cargo lines", () => {
		expect(
			toned(
				"pnpm test",
				"PASS src/a.test.ts\nTests:       1 failed, 2 skipped, 10 passed, 13 total",
			),
		).toEqual([
			"[good] PASS <path>src/a.test.ts</>",
			"Tests:       <bad>1 failed</>, <muted>2 skipped</>, <good>10 passed</>, 13 total",
		]);
		expect(
			toned(
				"python -m pytest -q",
				"FAILED tests/test_a.py::test_x - assert 1 == 2\nE       assert 1 == 2\n==== 1 failed, 3 passed in 0.21s ====",
			),
		).toEqual([
			"[bad] FAILED <path>tests/test_a.py</>::test_x - assert 1 == 2",
			"[bad] E       assert 1 == 2",
			"==== <bad>1 failed</>, <good>3 passed</> in 0.21s ====",
		]);
		expect(
			toned(
				"go test ./...",
				"--- FAIL: TestAdd (0.00s)\nok  \texample.com/pkg\t0.12s\n=== RUN   TestAdd\n--- SKIP: TestB (0.00s)",
			),
		).toEqual([
			"[bad] --- FAIL: TestAdd <muted>(0.00s)</>",
			"[good] ok  \texample.com/pkg\t<muted>0.12s</>",
			"[muted] === RUN   TestAdd",
			"[muted] --- SKIP: TestB (0.00s)",
		]);
		expect(
			toned(
				"cargo test",
				"test math::adds ... ok\ntest math::fails ... FAILED\nthread 'math::fails' panicked at src/lib.rs:4:5:\ntest result: FAILED. 1 passed; 1 failed; 0 ignored",
			),
		).toEqual([
			"[good] test math::adds ... ok",
			"[bad] test math::fails ... FAILED",
			"[bad] thread 'math::fails' panicked at <path>src/lib.rs:4:5</>:",
			"test result: <bad>FAILED</>. <good>1 passed</>; <bad>1 failed</>; <muted>0 ignored</>",
		]);
	});

	it("recognises test commands behind runners and package scripts", () => {
		for (const command of [
			"bun test",
			"npm run test:unit",
			"pnpm vitest",
			"cd app && CI=1 npx -y jest 2>&1 | tail -40",
			"/bin/bash -lc 'yarn test'",
		])
			expect(toned(command, "PASS a.test.ts")[0]).toBe(
				"[good] PASS <path>a.test.ts</>",
			);
	});
});

describe("build, lint and typecheck output", () => {
	it("colours tsc errors and locations", () => {
		expect(
			toned(
				"npx tsc --noEmit -p .",
				"src/a.ts(12,5): error TS2322: Type 'x' is not assignable.\nsrc/b.ts:3:1 - error TS1005: ';' expected.\nFound 2 errors in 2 files.",
			),
		).toEqual([
			"<path>src/a.ts(12,5)</>: <bad>error TS2322</>: Type 'x' is not assignable.",
			"<path>src/b.ts:3:1</> - <bad>error TS1005</>: ';' expected.",
			"Found <bad>2 errors</> in 2 files.",
		]);
	});

	it("colours eslint's stylish rows and summary", () => {
		expect(
			toned(
				"npm run lint",
				"/repo/src/a.ts\n  12:5  error    'x' is unused  no-unused-vars\n  3:1   warning  Prefer const   prefer-const\n✖ 2 problems (1 error, 1 warning)",
			),
		).toEqual([
			"<path>/repo/src/a.ts</>",
			"  <muted>12:5</>  <bad>error</>    'x' is unused  <muted>no-unused-vars</>",
			"  <muted>3:1</>   <warn>warning</>  Prefer const   <muted>prefer-const</>",
			"[bad] ✖ <bad>2 problems</> (<bad>1 error</>, <warn>1 warning</>)",
		]);
	});

	it("colours cargo and rustc diagnostics", () => {
		expect(
			toned(
				"cargo build",
				'error[E0308]: mismatched types\n  --> src/main.rs:4:5\n   |\n 4 |     let x: u8 = "a";\n   |                 ^^^ expected `u8`\nwarning: unused variable: `y`',
			),
		).toEqual([
			"[bad] error[E0308]: mismatched types",
			"<muted>  --></> <path>src/main.rs:4:5</>",
			"<muted>   |</>",
			'<muted> 4 |</>     let x: u8 = "a";',
			"<muted>   |</>                 <bad>^^^</> expected `u8`",
			"[warn] warning: unused variable: `y`",
		]);
	});

	it("colours biome diagnostics", () => {
		expect(
			toned(
				"npx biome check src",
				"src/a.ts:2:7 lint/style/useConst  FIXABLE\n  × This let declares a variable that is only assigned once.\nFound 1 error.",
			),
		).toEqual([
			"<path>src/a.ts:2:7</> lint/style/useConst  FIXABLE",
			"[bad]   × This let declares a variable that is only assigned once.",
			"Found <bad>1 error</>.",
		]);
	});
});

describe("listings", () => {
	it("colours ls -la entries by kind and mutes the metadata", () => {
		const [total, dir, dot, exec, link, file] = toned(
			"ls -la",
			[
				"total 48",
				"drwxr-xr-x  12 het  staff   384 Oct 31 14:08 src",
				"-rw-r--r--   1 het  staff   120 Oct 31 14:08 .env",
				"-rwxr-xr-x   1 het  staff  2048 Oct 31 14:08 run.sh",
				"lrwxr-xr-x   1 het  staff    10 Oct 31 14:08 latest -> builds/42",
				"-rw-r--r--   1 het  staff   900 Jan  2  2025 README.md",
			].join("\n"),
		);
		expect(total).toBe("[muted] total 48");
		expect(dir).toBe(
			"<muted>drwxr-xr-x  12 het  staff   384 Oct 31 14:08 </><path>src</>",
		);
		expect(dot).toMatch(/<muted>\.env<\/>$/);
		expect(exec).toMatch(/<good>run\.sh<\/>$/);
		expect(link).toMatch(/<accent>latest<\/><muted> -> builds\/42<\/>$/);
		expect(file).toMatch(/<\/>README\.md$/);
	});

	it("colours plain and -F ls output", () => {
		expect(toned("ls -F", "src/  run.sh*  .git/  README.md  link@")).toEqual([
			"<path>src/</>  <good>run.sh*</>  <muted>.git/</>  README.md  <accent>link@</>",
		]);
	});

	it("colours tree output, finding directories by their children", () => {
		expect(
			toned(
				"tree -L 2",
				".\n├── src\n│   ├── a.ts\n│   └── .env\n└── package.json\n\n1 directory, 3 files",
			),
		).toEqual([
			"[path] .",
			"<muted>├── </><path>src</>",
			"<muted>│   ├── </>a.ts",
			"<muted>│   └── </><muted>.env</>",
			"<muted>└── </>package.json",
			"",
			"[muted] 1 directory, 3 files",
		]);
	});

	it("colours find output, finding directories by the paths under them", () => {
		expect(toned("find . -maxdepth 2", "./src\n./src/a.ts\n./.github")).toEqual(
			["[path] ./src", "<muted>./src/</>a.ts", "[muted] ./.github"],
		);
	});
});

describe("git output", () => {
	it("colours short status codes and the branch line", () => {
		expect(
			toned(
				"git status -sb",
				"## main...origin/main [ahead 1]\n M src/a.ts\nA  src/new.ts\n D src/old.ts\n?? notes.txt\nR  a.ts -> b.ts",
			),
		).toEqual([
			"<muted>##</> <accent>main...origin/main</><muted> [ahead 1]</>",
			"[warn]  M src/a.ts",
			"[good] A  src/new.ts",
			"[bad]  D src/old.ts",
			"[muted] ?? notes.txt",
			"[warn] R  a.ts -> b.ts",
		]);
	});

	it("colours long status by section", () => {
		expect(
			toned(
				"git status",
				[
					"On branch launch-fixes",
					"Your branch is up to date with 'origin/main'.",
					"",
					"Changes to be committed:",
					'  (use "git restore --staged <file>..." to unstage)',
					"\tnew file:   src/new.ts",
					"\tmodified:   src/a.ts",
					"\tdeleted:    src/old.ts",
					"",
					"Untracked files:",
					"\tnotes.txt",
					"nothing to commit, working tree clean",
				].join("\n"),
			),
		).toEqual([
			"On branch <accent>launch-fixes</>",
			"Your branch is up to date with <accent>'origin/main'</>.",
			"",
			"[strong] Changes to be committed:",
			'[muted]   (use "git restore --staged <file>..." to unstage)',
			"[good] \tnew file:   src/new.ts",
			"[warn] \tmodified:   src/a.ts",
			"[bad] \tdeleted:    src/old.ts",
			"",
			"[strong] Untracked files:",
			"[muted] \tnotes.txt",
			"[good] nothing to commit, working tree clean",
		]);
	});

	it("colours log hashes and refs", () => {
		expect(
			toned(
				"git log --oneline --graph -3",
				"* 3f2a1bc (HEAD -> main, origin/main) Fix login\n* 9e8d7c6 Add tests",
			),
		).toEqual([
			"<muted>* </><warn>3f2a1bc</><accent> (HEAD -> main, origin/main)</> Fix login",
			"<muted>* </><warn>9e8d7c6</> Add tests",
		]);
		expect(
			toned(
				"git -C repo log -1",
				"commit 3f2a1bc4d5e6f708192a3b4c5d6e7f8091a2b3c4 (HEAD -> main)\nAuthor: Het <h@x.dev>",
			),
		).toEqual([
			"<muted>commit </><warn>3f2a1bc4d5e6f708192a3b4c5d6e7f8091a2b3c4</><accent> (HEAD -> main)</>",
			"[muted] Author: Het <h@x.dev>",
		]);
	});

	it("colours diff stats with the diff colours", () => {
		expect(
			toned(
				"git diff --stat",
				" src/a.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)",
			),
		).toEqual([
			" <path>src/a.ts</> | 5 <added>+++</><removed>--</>",
			" 1 file changed, <added>3 insertions(+)</>, <removed>2 deletions(-)</>",
		]);
	});

	it("colours branch lists", () => {
		expect(toned("git branch", "* main\n  feature/x")).toEqual([
			"<good>*</> <accent>main</>",
			"  <accent>feature/x</>",
		]);
	});
});

describe("generic output", () => {
	it("colours error, warning and success lines and URLs", () => {
		expect(
			toned(
				"./deploy.sh",
				"Error: connection refused\nnpm warn deprecated glob@7\nDone in 2.3s\nopen https://example.com/app now\nplain line",
			),
		).toEqual([
			"[bad] Error: connection refused",
			"[warn] npm warn deprecated glob@7",
			"[good] Done in 2.3s",
			"open <path>https://example.com/app</> now",
			"plain line",
		]);
	});

	it("reads exception names and tracebacks", () => {
		expect(genericTone("TypeError: x is undefined")).toBe("bad");
		expect(genericTone("Traceback (most recent call last):")).toBe("bad");
		expect(genericTone("fatal: not a git repository")).toBe("bad");
	});

	it("does not read words inside paths, identifiers or zero counts", () => {
		for (const text of [
			"src/error-boundary.tsx",
			"modified: src/features/errors.ts",
			"import { onError } from './error_handler'",
			"Found 0 errors",
			"warnings: 0",
			"no errors",
			"see https://x.dev/errors?failed=1",
			"ValidationError.ts",
		])
			expect(genericTone(text), text).toBeUndefined();
	});

	it("does not colour listings or searches red for an error-named file", () => {
		expect(toned("ls", "error-boundary.tsx")).toEqual(["error-boundary.tsx"]);
		expect(toned("find src", "src/error-boundary.tsx")).toEqual([
			"<muted>src/</>error-boundary.tsx",
		]);
		expect(
			toned("rg -n Boundary", "src/error-boundary.tsx:1:Boundary")[0],
		).toBe("<path>src/error-boundary.tsx</><muted>:1:</><match>Boundary</>");
		expect(toned("npx tsc", "src/error-boundary.tsx(1,1): message")[0]).toBe(
			"<path>src/error-boundary.tsx(1,1)</>: message",
		);
	});
});

describe("ANSI escapes", () => {
	it("maps the standard colours to the palette and drops the escapes", () => {
		expect(
			toned(
				"pnpm build",
				"\u001b[32m✓\u001b[39m built\n\u001b[31;1merror\u001b[0m bad\n\u001b[90mdim\u001b[0m \u001b[36mcyan\u001b[0m",
			),
		).toEqual([
			"<good>✓</> built",
			"<bad>error</> bad",
			"<muted>dim</> <path>cyan</>",
		]);
	});

	it("carries colour across lines and handles 256-colour codes", () => {
		expect(
			toned("x", "\u001b[33mone\ntwo\u001b[0m\n\u001b[38;5;9mred\u001b[0m"),
		).toEqual(["<warn>one</>", "<warn>two</>", "<bad>red</>"]);
	});

	it("strips escapes that carry no colour, then classifies", () => {
		expect(
			toned(
				"x",
				"\u001b[1mBuild\u001b[22m failed\n\u001b[2K\rprogress 10%\rprogress 100%",
			),
		).toEqual(["[bad] Build failed", "progress 100%"]);
	});
});

describe("limits", () => {
	it("classifies only the first lines and leaves the rest plain", () => {
		const output = Array.from(
			{ length: 5 },
			(_, index) => `error in step ${index}`,
		).join("\n");
		const result = commandOutputTones("x", output, 2);
		expect(result.lines.map(render)).toEqual([
			"[bad] error in step 0",
			"[bad] error in step 1",
		]);
		expect(result.rest).toBe(
			"error in step 2\nerror in step 3\nerror in step 4",
		);
	});

	it("leaves very long lines plain", () => {
		const long = `error ${"x".repeat(3000)}`;
		expect(commandOutputTones("x", long).lines[0]).toEqual({
			spans: [{ text: long }],
		});
	});
});

it("splits shell commands into simple commands", () => {
	expect(
		shellSegments(`cd a && rg -n "a b" src 2>/dev/null | head -5; echo 'x|y'`),
	).toEqual([
		["cd", "a"],
		["rg", "-n", "a b", "src"],
		["head", "-5"],
		["echo", "x|y"],
	]);
	expect(shellSegments(`npm test 2>&1 | tail`)).toEqual([
		["npm", "test"],
		["tail"],
	]);
});

describe("verdict lines", () => {
	it("tones a line that opens with its verdict by that verdict, not the words it quotes", () => {
		const inner =
			"test -s docs/a.mp4 && ffprobe -v error -show_entries format=duration docs/a.mp4";
		const tones = commandOutputTones(
			`ytimesy-check --files README.md -- bash -lc '${inner}'`,
			`PASSED: clean-copy run of ${JSON.stringify(inner)}\nFAILED: clean-copy run of "true"`,
		).lines.map((line) => line.tone);
		expect(tones).toEqual(["good", "bad"]);
		expect(genericTone("Error: no such file")).toBe("bad");
	});
});
