---
name: live-validation
description: Every form field with a rule is validated as the user types, including conflicts with data already loaded
files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*"]
when: <form|<input|<Input|<textarea|<Textarea|<select|onSubmit|handleSubmit|useForm
---

A field the server will reject (required, format, length, range, uniqueness, reserved values) shows the problem inline as the user types or leaves it, against the same schema the server uses, and submit stays disabled while it is invalid.
Uniqueness and "already in use" are checked against data the page already holds (the list it loaded or rendered), normalized the way the server compares, excluding the record's own value when editing.
Fails: an error that only appears after submit ("You already have a tool with that name") when the client had the data to know; a rule enforced on some fields and not others.
Passes: inline errors from the shared schema; a server-only check when the client genuinely cannot hold the set.
