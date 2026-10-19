import unittest

from utils.textfmt import indent_block, slugify, strip_markup, title_case, truncate, wrap


class TextfmtTest(unittest.TestCase):
    def test_wrap(self):
        self.assertEqual(wrap("one two three four", 9), "one two\nthree\nfour")

    def test_truncate(self):
        self.assertEqual(truncate("hello   world", 20), "hello world")
        self.assertEqual(truncate("hello wonderful world", 12), "hello won...")

    def test_slugify(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("!!!"), "untitled")

    def test_title_case(self):
        self.assertEqual(title_case("the art of the deal"), "The Art of the Deal")

    def test_strip_markup(self):
        self.assertEqual(strip_markup("**bold** and [link](http://x)"), "bold and link")

    def test_indent_block(self):
        self.assertEqual(indent_block("a\n\nb", "> "), "> a\n\n> b")
