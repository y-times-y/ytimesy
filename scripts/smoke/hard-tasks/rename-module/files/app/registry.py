"""Formatter registry: formatters are named as "module:function" strings."""

import importlib
import json
from pathlib import Path

DEFAULTS = {
    "title": "utils.textfmt:title_case",
    "plain": "utils.textfmt:strip_markup",
    "short": "utils.textfmt:truncate",
}
CONFIG = Path(__file__).with_name("formatters.json")


def resolve(spec):
    module_name, _, attr = spec.partition(":")
    return getattr(importlib.import_module(module_name), attr)


def load():
    names = dict(DEFAULTS)
    names.update(json.loads(CONFIG.read_text()))
    return {key: resolve(spec) for key, spec in names.items()}


def apply(name, text, *args):
    return load()[name](text, *args)
