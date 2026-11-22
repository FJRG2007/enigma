---
name: data-view-affordances
description: A table or record list (logs, history, records, admin data) ships the affordances its user will reach for and all of its states
files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*"]
when: <table|<Table|DataTable|DataGrid|<thead|useReactTable|getCoreRowModel|columns\s*[=:]|<TableRow|<tr\b
---

Scope first: this applies ONLY to a table or record list the user searches and works through (logs, history, orders, users, admin data). A navigation list - a chat or conversation sidebar, a channel or file tree, tabs, a menu - is out of scope: pass it.
In scope, the view includes: search and filters (state in the URL), sorting, pagination or virtualized infinite scroll, a name or id that opens or reveals its record, copy on values people copy, human labels for machine codes, and loading (skeleton shaped like the rows), empty and error states with an action.
Fails: a new list or table missing any of those that its data obviously needs, or rendering a raw status code or id as plain text.
Passes: a short fixed list (a menu, a few settings) that needs none of them.
