---
name: data-view-affordances
description: A list or table ships the affordances its user will reach for and all of its states
files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*"]
when: <table|<Table|DataTable|\.map\(|<ul|<li|columns|rows
---

A view that lists records the user works with daily includes: search and filters (state in the URL), sorting, pagination or virtualized infinite scroll, a name or id that opens or reveals its record, copy on values people copy, human labels for machine codes, and loading (skeleton shaped like the rows), empty and error states with an action.
Fails: a new list or table missing any of those that its data obviously needs, or rendering a raw status code or id as plain text.
Passes: a short fixed list (a menu, a few settings) that needs none of them.
