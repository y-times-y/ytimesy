import unittest

import app
from app import email, export, report, search
from app.plugins import markdown
from utils.paths import archive_path

NOTES = [
    {"title": "Launch plan", "body": "Ship the **beta** on Friday after review.", "date": "2026-02-01"},
    {"title": "retro notes", "body": "What went well: the [demo](http://d) and docs.", "date": "2026-01-15"},
]


class AppTest(unittest.TestCase):
    def test_app_name(self):
        self.assertEqual(app.APP_NAME, "Notes for the Team")

    def test_report(self):
        self.assertEqual(report.summary(NOTES, 20), "launch-plan: Ship the **beta**...\nretro-notes: What went well: t...")

    def test_email(self):
        self.assertEqual(email.subject("the plan for the quarter"), "[notes] The Plan for the Quarter")
        self.assertEqual(email.preview("**bold** words here", 10), "bold wo...")
        self.assertIn("- Retro Notes: What went well: the demo and docs.", email.digest(NOTES))

    def test_search(self):
        self.assertEqual([n["title"] for n in search.search(NOTES, "demo")], ["retro notes"])
        self.assertEqual(search.search(NOTES, "the", since="2026-01-20"), [NOTES[0]])

    def test_export(self):
        files = export.export_notes(NOTES)
        self.assertEqual(sorted(files), ["index.md", "launch-plan.md", "retro-notes.md"])
        self.assertEqual(files["index.md"], "- launch-plan\n- retro-notes\n")

    def test_markdown_plugin(self):
        self.assertEqual(markdown.heading("  **the** end  \n\n"), "The End")

    def test_paths(self):
        self.assertEqual(archive_path(2026, "Q1: Goals!"), "archive/2026/q1-goals.md")
