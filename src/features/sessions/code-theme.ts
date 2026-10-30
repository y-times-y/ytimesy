/**
 * ytimesy's code colours ("Ember Dusk"): every highlighted code in the app,
 * from chat code blocks to tool calls, file previews and pull request diffs.
 *
 * Built on Monokai Extended's token rules with our own colour in each role:
 * rose-coral keywords, sunflower functions, sky-blue types, lime strings,
 * peach numbers. The background matches GitHub Dark, which this replaced, so
 * code blocks keep their surfaces.
 *
 * Monokai Extended (https://github.com/jonschlinkert/sublime-monokai-extended):
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2013-2016, Jon Schlinkert.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import type { ThemeRegistrationAny } from "shiki";

export const ytimesyCodeTheme = {
	name: "ytimesy-dusk",
	type: "dark",
	colors: {
		"editor.background": "#24292e",
		"editor.foreground": "#f8f8f2",
	},
	tokenColors: [
		{
			scope: ["comment"],
			settings: {
				foreground: "#6b6660",
			},
		},
		{
			scope: ["string"],
			settings: {
				foreground: "#b8e986",
			},
		},
		{
			scope: ["constant.numeric"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: ["constant.language", "meta.preprocessor"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: ["constant.character", "constant.other"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: ["variable.language", "variable.other"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["keyword"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["storage"],
			settings: {
				fontStyle: "",
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["storage.type"],
			settings: {
				fontStyle: " italic",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["entity.name.class"],
			settings: {
				fontStyle: " underline",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["entity.other.inherited-class"],
			settings: {
				fontStyle: "italic underline",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["entity.name.function"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["variable.parameter"],
			settings: {
				fontStyle: " italic",
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["entity.name.tag"],
			settings: {
				fontStyle: "",
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["entity.other.attribute-name"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["support.function"],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["support.constant"],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["support.type", "support.class"],
			settings: {
				fontStyle: "italic",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["support.other.variable"],
			settings: {
				fontStyle: "",
			},
		},
		{
			scope: ["string constant"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["string.regexp"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["string variable"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["punctuation.definition.variable"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["entity"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"meta.tag.sgml.doctype.xml",
				"declaration.sgml.html declaration.doctype",
				"declaration.sgml.html declaration.doctype entity",
				"declaration.sgml.html declaration.doctype string",
				"declaration.xml-processing",
				"declaration.xml-processing entity",
				"declaration.xml-processing string",
				"doctype",
			],
			settings: {
				foreground: "#c8cecc",
			},
		},
		{
			scope: ["comment.block.html"],
			settings: {
				fontStyle: "",
				foreground: "#6b6660",
			},
		},
		{
			scope: ["entity.name.tag.script.html"],
			settings: {
				fontStyle: "italic",
			},
		},
		{
			scope: [
				"text.html.basic meta.tag.other.html",
				"text.html.basic meta.tag.any.html",
				"text.html.basic meta.tag.block.any",
				"text.html.basic meta.tag.inline.any",
				"text.html.basic meta.tag.structure.any.html",
				"text.html.basic source.js.embedded.html",
				"punctuation.separator.key-value.html",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["text.html.basic entity.other.attribute-name.html"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"text.html.basic meta.tag.structure.any.html punctuation.definition.string.begin.html",
				"punctuation.definition.string.begin.html",
				"punctuation.definition.string.end.html",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"punctuation.definition.tag.end",
				"punctuation.definition.tag.begin",
				"punctuation.definition.tag",
			],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["variable.parameter.handlebars"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: [
				"support.constant.handlebars",
				"meta.function.block.start.handlebars",
			],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["meta.preprocessor.at-rule keyword.control.at-rule"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["meta.selector.css entity.other.attribute-name.id"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["meta.selector.css entity.other.attribute-name.class"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["support.type.property-name.css"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["meta.constructor.argument.css"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["punctuation.section.property-list.css"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["punctuation.definition.tag.css"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: [
				"punctuation.separator.key-value.css",
				"punctuation.terminator.rule.css",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"entity.other.attribute-name.pseudo-element.css",
				"entity.other.attribute-name.pseudo-class.css",
				"entity.other.attribute-name.pseudo-selector.css",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["variable.other.less"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["entity.other.less.mixin"],
			settings: {
				fontStyle: " italic",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["entity.other.attribute-name.pseudo-element.less"],
			settings: {
				fontStyle: "",
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["meta.instance.constructor meta.function-call.constructor.js"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"meta.template.expression.js punctuation.definition.template-expression.begin.js",
				"meta.template.expression.js punctuation.definition.template-expression.end.js",
				"meta.template.expression.js punctuation.accessor",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"meta.function.js",
				"entity.name.function.js",
				"support.function.dom.js",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"source.js meta.function.js punctuation.separator.parameter.function.js",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: ["meta.property.object.js", "keyword.operator.accessor.js"],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"source.js meta.group.braces.curly constant.other.object.key.js punctuation.separator.key-value.js",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"source.js meta.group.braces.curly constant.other.object.key.js string.unquoted.label.js",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"support.type.object.module.js",
				"source.js meta.function.declaration.js support.class.js",
			],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["support.type.object.module.js support.type.object.module.js"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["storage.type.js"],
			settings: {
				fontStyle: " italic",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["text.html.basic source.js.embedded.html"],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: ["storage.type.function.js"],
			settings: {
				fontStyle: " italic",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["constant.numeric.js"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: [
				"variable.language.arguments.js",
				"variable.language.super.js",
				"variable.language.this.js",
				"variable.language.self.js",
				"variable.language.proto.js",
				"variable.language.constructor.js",
				"variable.language.prototype.js",
			],
			settings: {
				fontStyle: " italic",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["meta.brace.square.js"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"meta.brace.round",
				"punctuation.definition.parameters.begin.js",
				"punctuation.definition.parameters.end.js",
				"punctuation.definition.group",
			],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["meta.brace.curly.js", "meta.object-literal.js"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["meta.structure.dictionary.json string.quoted.double.json"],
			settings: {
				foreground: "#cfcfc2",
			},
		},
		{
			scope: ["punctuation.section.embedded.coffee"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: [
				"keyword.operator.index-start.php",
				"keyword.operator.index-end.php",
			],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["meta.array.php"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"meta.array.php support.function.construct.php",
				"meta.array.empty.php support.function.construct.php",
			],
			settings: {
				fontStyle: "",
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["support.function.construct.php"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["storage.type.function.php"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["constant.numeric.php"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: ["keyword.other.new.php"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["support.class.php"],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: ["variable.other.property.php"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: [
				"storage.modifier.extends.php",
				"storage.type.class.php",
				"keyword.operator.class.php",
			],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["meta.other.inherited-class.php"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["storage.type.php"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["entity.name.function.php"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["support.function.construct.php"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"entity.name.type.class.php",
				"meta.function-call.php",
				"meta.function-call.static.php",
				"meta.function-call.object.php",
			],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["keyword.other.phpdoc"],
			settings: {
				fontStyle: "",
				foreground: "#6b6660",
			},
		},
		{
			scope: ["source.php.embedded.block.html"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["invalid"],
			settings: {
				fontStyle: "",
				foreground: "#f8f8f0",
			},
		},
		{
			scope: ["invalid.deprecated"],
			settings: {
				foreground: "#f8f8f0",
			},
		},
		{
			scope: ["meta.diff", "meta.diff.header"],
			settings: {
				foreground: "#6b6660",
			},
		},
		{
			scope: ["markup.deleted"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["markup.inserted"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["markup.changed"],
			settings: {
				foreground: "#b8e986",
			},
		},
		{
			scope: ["meta.diff", "meta.diff.range"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: [
				"storage.type.class.python",
				"storage.type.function.python",
				"storage.modifier.global.python",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"keyword.control.import.python",
				"keyword.control.import.from.python",
			],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["support.type.exception.python"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: [
				"punctuation.definition.variable.perl",
				"variable.other.readwrite.global.perl",
				"variable.other.predefined.perl",
				"keyword.operator.comparison.perl",
			],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["support.function.perl"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["comment.line.number-sign.perl"],
			settings: {
				fontStyle: "italic",
				foreground: "#6b6660",
			},
		},
		{
			scope: [
				"punctuation.definition.string.begin.perl",
				"punctuation.definition.string.end.perl",
			],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["constant.character.escape.perl"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["constant.language.ruby", "constant.numeric.ruby"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: ["punctuation.definition.variable.ruby"],
			settings: {
				fontStyle: "",
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["meta.function.method.with-arguments.ruby"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["variable.language.ruby"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["entity.name.function.ruby"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["keyword.control.ruby", "keyword.control.def.ruby"],
			settings: {
				fontStyle: "bold",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["keyword.control.class.ruby", "meta.class.ruby"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["entity.name.type.class.ruby"],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["keyword.control.ruby"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["support.class.ruby"],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["keyword.other.special-method.ruby"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["variable.other.constant.ruby"],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["constant.other.symbol.ruby"],
			settings: {
				fontStyle: "",
				foreground: "#b8e986",
			},
		},
		{
			scope: [
				"punctuation.section.embedded.ruby",
				"punctuation.definition.string.begin.ruby",
				"punctuation.definition.string.end.ruby",
			],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["keyword.other.special-method.ruby"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["text.html.markdown"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: ["text.html.markdown markup.raw.inline"],
			settings: {
				foreground: "#ec3533",
			},
		},
		{
			scope: ["text.html.markdown meta.dummy.line-break"],
			settings: {
				foreground: "#e0eddd",
			},
		},
		{
			scope: [
				"markdown.heading",
				"markup.heading | markup.heading entity.name",
				"markup.heading.markdown punctuation.definition.heading.markdown",
			],
			settings: {
				fontStyle: "",
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["markup.italic"],
			settings: {
				fontStyle: "italic",
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["markup.bold"],
			settings: {
				fontStyle: "bold",
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["markup.underline"],
			settings: {
				fontStyle: "underline",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["markup.strike"],
			settings: {
				fontStyle: "",
				foreground: "#cc4273",
			},
		},
		{
			scope: ["markup.quote", "punctuation.definition.blockquote.markdown"],
			settings: {
				fontStyle: "italic",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["markup.quote"],
			settings: {
				fontStyle: " italic",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["string.other.link.title.markdown"],
			settings: {
				fontStyle: "underline",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["markup.raw.block"],
			settings: {
				foreground: "#ffb38a",
			},
		},
		{
			scope: ["punctuation.definition.list_item.markdown"],
			settings: {
				foreground: "#777777",
			},
		},
		{
			scope: ["markup.raw.block.fenced.markdown"],
			settings: {
				foreground: "#ffffff",
			},
		},
		{
			scope: [
				"punctuation.definition.fenced.markdown",
				"variable.language.fenced.markdown",
			],
			settings: {
				foreground: "#636050",
			},
		},
		{
			scope: ["variable.language.fenced.markdown"],
			settings: {
				fontStyle: "",
				foreground: "#6b6660",
			},
		},
		{
			scope: ["meta.separator"],
			settings: {
				fontStyle: "bold",
				foreground: "#ffffff33",
			},
		},
		{
			scope: ["markup.table"],
			settings: {
				foreground: "#b42a1d",
			},
		},
		{
			scope: ["variable.other.math.tex"],
			settings: {
				foreground: "#b8e986",
			},
		},
		{
			scope: ["other.package.exclude", "other.remove"],
			settings: {
				fontStyle: "",
				foreground: "#d3201f",
			},
		},
		{
			scope: ["support.function.builtin.shell"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["variable.other.normal.shell"],
			settings: {
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["source.shell"],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: ["meta.scope.for-in-loop.shell", "variable.other.loop.shell"],
			settings: {
				fontStyle: "",
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["entity.name.function.shell"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: [
				"punctuation.definition.string.end.shell",
				"punctuation.definition.string.begin.shell",
			],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: ["meta.scope.case-block.shell", "meta.scope.case-body.shell"],
			settings: {
				fontStyle: "",
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["punctuation.definition.logical-expression.shell"],
			settings: {
				fontStyle: "",
				foreground: "#ffffff",
			},
		},
		{
			scope: ["comment.line.number-sign.shell"],
			settings: {
				fontStyle: "italic",
				foreground: "#6b6660",
			},
		},
		{
			scope: ["comment.line.number-sign.makefile"],
			settings: {
				fontStyle: "",
				foreground: "#6b6660",
			},
		},
		{
			scope: ["punctuation.definition.comment.makefile"],
			settings: {
				fontStyle: "",
				foreground: "#6b6660",
			},
		},
		{
			scope: ["variable.other.makefile"],
			settings: {
				fontStyle: "",
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["entity.name.function.makefile"],
			settings: {
				fontStyle: "",
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["meta.function.makefile"],
			settings: {
				fontStyle: "",
				foreground: "#6cb6ff",
			},
		},
		{
			scope: ["markup.deleted.git_gutter"],
			settings: {
				foreground: "#ff6f7d",
			},
		},
		{
			scope: ["markup.inserted.git_gutter"],
			settings: {
				foreground: "#ffcc4d",
			},
		},
		{
			scope: ["markup.changed.git_gutter"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
		{
			scope: ["markup.ignored.git_gutter"],
			settings: {
				foreground: "#565656",
			},
		},
		{
			scope: ["markup.untracked.git_gutter"],
			settings: {
				foreground: "#565656",
			},
		},
		{
			scope: ["string.other.path.nginx"],
			settings: {
				foreground: "#ff9f6b",
			},
		},
	],
} satisfies ThemeRegistrationAny;
