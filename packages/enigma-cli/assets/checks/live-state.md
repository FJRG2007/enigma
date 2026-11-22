---
name: live-state
description: Mutations show instantly with rollback, and every view derived from shared data stays correct on every change without a reload
files: ["*.tsx", "*.jsx", "*.ts", "*.js", "*.vue", "*.svelte"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*", "**/server/**", "**/api/**", "**/migrations/**"]
when: fetch\(|mutate|useMutation|axios\.|\.(post|put|patch|delete)\(|socket|subscribe|onMessage|EventSource|setState|set[A-Z]\w*\(|useQuery|useSWR|\.sort\(
---

A user-facing mutation updates the UI at once (optimistic) and rolls back with a visible error if the server rejects it; it never waits on the round trip to show what the user just did.
Every view derived from the same data (list order by recency, unread counts, last-message previews, badges, totals, "updated" times) is recomputed from one source of truth on EVERY change source: the user's own mutation, a realtime event, a background refetch, another tab. Order and counts are derived, never stored separately and patched by hand.
Fails: a chat list that keeps its old order after a new message until reload; a counter that updates in one panel and not the other; a send that appears only after the server answers; an event handler that patches the item but not the sort or the count.
Passes: one store or query cache updated by mutations and events alike, with sorting and counts derived from it on render; optimistic write plus rollback.
