import unittest

from app import registry
from app.cli import main


class RegistryTest(unittest.TestCase):
    def test_resolve(self):
        self.assertEqual(registry.resolve("utils.textfmt:slugify")("A B"), "a-b")

    def test_load_has_all(self):
        self.assertEqual(sorted(registry.load()), ["date", "plain", "quote", "short", "slug", "title", "wrap"])

    def test_apply(self):
        self.assertEqual(registry.apply("title", "a tale of two cities"), "A Tale of Two Cities")
        self.assertEqual(registry.apply("date", "2026-01-02"), "02 Jan 2026")

    def test_cli(self):
        with unittest.mock.patch("builtins.print") as out:
            main(["slug", "Hello", "There"])
        out.assert_called_once_with("hello-there")


import unittest.mock  # noqa: E402
