# notes

A small note-publishing toolkit. Run the tests with
`python3 -m unittest discover -s tests -t .`.

- `utils.textfmt`: text formatting helpers (`wrap`, `truncate`, `slugify`,
  `title_case`, `strip_markup`, `indent_block`). `utils` re-exports `wrap`,
  `truncate` and `slugify` for convenience.
- `utils.dates`, `utils.paths`: date and path helpers.
- `app`: rendering, search, export and the CLI. Formatters can be named in
  `app/formatters.json` as `"module:function"` strings; see `app/registry.py`.

See `docs/formatting.md` for the formatting rules.
