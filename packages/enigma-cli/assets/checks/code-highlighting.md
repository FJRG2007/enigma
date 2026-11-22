---
name: code-highlighting
description: Code that a UI shows or edits is syntax highlighted
files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*"]
when: <pre|<code|textarea|markdown|marked|json|script|snippet|sql|yaml|config|editor
---

Wherever the UI displays or edits code (a script, JSON input or payload, config, SQL, a shell command, a diff, code blocks inside rendered markdown), it goes through a syntax highlighter for display (shiki, prism, highlight.js or the project's CodeBlock) and a code editor for editing (CodeMirror, Monaco or the project's CodeEditor) with the language set.
Fails: `<pre>{code}</pre>`, `<pre>{JSON.stringify(x)}</pre>`, a plain textarea bound to a script/JSON/config value, a markdown renderer with no highlighting plugin.
Passes: plain prose, logs and notes in a pre; code rendered through a highlighter or editor component.
