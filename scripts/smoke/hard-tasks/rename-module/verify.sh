test ! -e utils/textfmt.py
test -f formatting/text.py && test -f tests/test_text.py && test ! -e tests/test_textfmt.py
if grep -rIn textfmt --exclude-dir=.git --exclude-dir=__pycache__ .; then echo "old name still present"; exit 1; fi
out=$(python3 -m unittest discover -s tests -t . 2>&1) || { echo "$out" | tail -15; exit 1; }
echo "$out" | tail -3
ran=$(echo "$out" | sed -n 's/^Ran \([0-9]*\) test.*/\1/p')
[ "${ran:-0}" -ge 20 ] || { echo "only $ran tests ran (expected the original 20+)"; exit 1; }
cat > "$hidden/hidden_rename.py" <<'PY'
import importlib
import json
import unittest
from unittest import mock


class Hidden(unittest.TestCase):
    def test_old_module_gone(self):
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("utils.textfmt")
        import utils
        for name in ("wrap", "truncate", "slugify", "textfmt"):
            self.assertFalse(hasattr(utils, name), name)

    def test_new_module_and_reexport(self):
        import formatting
        from formatting import text
        for name in ("wrap", "truncate", "slugify"):
            self.assertIs(getattr(formatting, name), getattr(text, name))
        self.assertEqual(text.wrap("one two three four", 9), "one two\nthree\nfour")
        self.assertEqual(text.truncate("hello wonderful world", 12), "hello won...")
        self.assertEqual(text.slugify("!!!"), "untitled")
        self.assertEqual(text.title_case("the art of the deal"), "The Art of the Deal")
        self.assertEqual(text.strip_markup("**b** [l](u)"), "b l")
        self.assertEqual(text.indent_block("a\n\nb", "> "), "> a\n\n> b")

    def test_callers(self):
        import app
        from app import email, export, render, report, search
        from app.plugins import markdown
        from utils.paths import archive_path
        self.assertEqual(app.APP_NAME, "Notes for the Team")
        self.assertEqual(email.subject("a note about the text module"), "[notes] A Note About the Text Module")
        self.assertEqual(email.preview("__x__ and `y` text", 20), "x and y text")
        self.assertEqual(email.digest([{"title": "the text", "body": "plain text body"}]), "- The Text: plain text body")
        self.assertEqual(report.summary_line({"title": "A!", "body": "b " * 30}, 9), "a: b b b...")
        self.assertEqual(markdown.heading("*on* text"), "On Text")
        self.assertEqual(archive_path(2025, "X Y"), "archive/2025/x-y.md")
        self.assertEqual(export.export_notes([{"title": "T 1", "body": "b"}])["index.md"], "- t-1\n")
        self.assertEqual(len(search.search([{"title": "x", "body": "**hit**", "date": "2026-01-01"}], "hit")), 1)
        note = {"title": "a", "body": "b", "date": "2026-01-01"}
        self.assertIn("A", render.render_note(note))

    def test_registry(self):
        from app import registry
        names = dict(registry.DEFAULTS)
        names.update(json.loads(registry.CONFIG.read_text()))
        self.assertEqual(sorted(names), ["date", "plain", "quote", "short", "slug", "title", "wrap"])
        from formatting import text
        for key, spec in names.items():
            if key != "date":
                self.assertTrue(spec.startswith("formatting.text:"), spec)
                self.assertIs(registry.resolve(spec), getattr(text, spec.split(":")[1]))
        self.assertEqual(registry.apply("short", "x" * 30, 10), "xxxxxxx...")

    def test_cli(self):
        from app.cli import main
        with mock.patch("builtins.print") as out:
            main(["short", "a long line of words for the cli"])
            main(["wrap", "tiny"])
        self.assertEqual([c.args[0] for c in out.call_args_list], ["a long line of wo...", "tiny"])


if __name__ == "__main__":
    unittest.main()
PY
cd "$hidden" && PYTHONPATH="$repo" python3 hidden_rename.py 2>&1 | tail -4
