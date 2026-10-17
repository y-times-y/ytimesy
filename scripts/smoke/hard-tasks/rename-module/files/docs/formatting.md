# Formatting

All text formatting lives in `utils.textfmt`. Import helpers from there
(`from utils.textfmt import wrap`) rather than re-implementing them.

Formatter names in `app/formatters.json` use the `module:function` form,
for example `utils.textfmt:title_case`.
