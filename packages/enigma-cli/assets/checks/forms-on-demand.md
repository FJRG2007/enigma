---
name: forms-on-demand
description: Create, edit, import and share forms open from a button, never laid out permanently under a list
files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/*.stories.*"]
when: <form|onSubmit|@submit|handleSubmit|useForm|<input\b|<Input\b|<TextField\b|<textarea\b|v-model
---

A view that lists records (hosts, members, keys, webhooks, addresses) keeps its create, edit, import and share flows behind the action that starts them: an "Add"/"New" button in the header and the empty state opening a dialog, sheet, inline row or page; edit from the record's own action, prefilled; import/export/share as buttons or menu items opening their own panel.
Fails: a create or edit form, or an import/share/QR panel, rendered unconditionally on the same view as the list it adds to; an empty input plus Add button always present at the end of a list (a blank email or phone field under the existing ones).
Passes: the form shown only after its trigger (dialog/sheet/disclosure state, a route); a page whose purpose is the form itself (sign in, checkout, a profile or preferences page of single values, a search bar, a composer).
