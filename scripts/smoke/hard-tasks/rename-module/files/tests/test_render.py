import unittest
from unittest import mock

from app.render import render_note

NOTE = {"title": "notes on the move", "body": "We are moving the office next week.", "date": "2026-03-05"}


class RenderTest(unittest.TestCase):
    def test_render(self):
        self.assertEqual(
            render_note(NOTE, 20),
            "Notes on the Move\n=================\n05 Mar 2026\n\nWe are moving the\noffice next week.",
        )

    def test_render_uses_wrap(self):
        with mock.patch("app.render.wrap", return_value="BODY") as fake:
            self.assertTrue(render_note(NOTE).endswith("BODY"))
        fake.assert_called_once()

    def test_quote(self):
        note = dict(NOTE, quote="short quote")
        self.assertTrue(render_note(note).endswith("  > short quote"))
