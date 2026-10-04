---
name: search-quality
description: Check that a search box finds the right thing and says "no results" when nothing matches - fuzzy matching tuned so loose it returns everything, missing typo tolerance, bad ranking, no empty state. Use on any search, filter, finder or command palette.
---

# Search quality

A search that cannot return nothing is broken, however good it looks on the happy path.

## Three queries, every time

1. **An exact item** - it must come first.
2. **A one-letter typo of it** - it must still be found.
3. **A word that appears nowhere** - it must return nothing and show an empty state that names
   the query.

Run all three in the browser on the real data, not only in a unit test.

## Usual causes

- fuse.js left at its default `threshold` (0.6), often with `ignoreLocation: true`: nearly every
  item matches. Use about 0.3, `minMatchCharLength: 2`, and weight the title above long text.
- Searching a long description field with the same weight as the title.
- A substring `includes()` filter: no typo tolerance and no ranking.
- No empty state, so "no matches" looks like a broken page or the full list stays visible.
- Searching only the loaded page of a server-paginated list without saying so.

## Report

| Query | Expected | Got | Cause (`file:line`) | Fix |
