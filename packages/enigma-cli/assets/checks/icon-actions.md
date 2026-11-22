---
name: icon-actions
description: Actions use icons (row and card actions) or icon plus label (primary actions), never a bare word
files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*"]
when: (?:edit|delete|remove|rename|duplicate|copy|download|share|refresh|archive|create|add|new)\b
---

Repeated row, card and toolbar actions (edit, delete, remove, rename, duplicate, copy, download, share, refresh, archive) are icon buttons from the project's one icon set, with an aria-label naming the action and its target and a tooltip. Primary or creating actions (create, add, new, save as) show the icon plus the label.
Fails: a button, link or menu item whose only content is a word for one of those actions, including a translated label (`{t("remove")}`).
Passes: icon-only with aria-label; icon plus label; a word-only label the design explicitly calls for.
