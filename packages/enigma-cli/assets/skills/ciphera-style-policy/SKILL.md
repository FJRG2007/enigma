---
name: ciphera-style-policy
description: Ciphera code style conventions - mandatory formatting and language idioms for source code (TypeScript-first, applies to every language) - American-English naming, double quotes, string interpolation, length-sorted imports, 4-space indentation, comment/JSDoc format, compact single-line blocks, and code-level anti-patterns (barrel files, external CDN/hosting dependencies). Use whenever writing, refactoring, or reviewing source code.
---

# Ciphera Code Style Policy

## Activation Scope

- Apply whenever source code is written, refactored, or reviewed, in any language.
- This skill owns code-level style: formatting, naming, quotes, imports, indentation, comments, and idiomatic compactness.
- Examples are TypeScript-first, but the rules apply to every language unless the language idiom dictates otherwise.

---

## Precedence (Read First)

- These are Layer 3 style rules and rank lowest in the core priority hierarchy.
- When editing an existing file or project, match its established style (indentation width, quote style, naming) - architecture/consistency outranks style per core-engineering-policy. Do not reformat working code just to satisfy this skill.
- Ciphera style governs new code and greenfield modules.
- Commit, branch, and pull request conventions are owned by git-policy. Ciphera-style commit emojis are defined and applied there (default on, user-disableable); do not restate the map here. Outside the commit subject, the no-emoji output rule in core-engineering-policy still holds.
- Reuse, single-use-variable, and anti-overengineering rules are owned by core-engineering-policy; this skill does not restate them.

---

## Naming & Language

- Write all identifiers, comments, and documentation in American English.
- Use the case the language idiom requires: camelCase for TypeScript/JavaScript identifiers, snake_case where that is the convention (e.g. Python).

```ts
// Bad
const nombre = "Jack";
const fetch_data = await fetch("/api");

// Good
const name = "Jack";
const fetchData = await fetch("/api");
```

---

## Strings & Quotes

- Use double quotes for strings and imports where the language supports them.
- Use string interpolation / template literals instead of concatenation.

```ts
// Bad
import DymoAPI from 'dymo-api';
const path = "/path/to/" + folderName + "/file";

// Good
import DymoAPI from "dymo-api";
const path = `/path/to/${folderName}/file`;
```

---

## Imports

- Sort imports by line length, shortest first.
- Do not import from external hostings or CDNs; depend on a package name, not a remote URL.
- For obscure libraries, vendor the needed code into the project utilities instead of adding a fragile dependency.

```ts
// Good
import axios from "axios";
import DymoAPI from "dymo-api";
```

---

## Formatting & Compactness

- Use semicolons in languages that use them (e.g. JavaScript/TypeScript).
- Use 4-space indentation for new code.
- Use the single-line form for one-line blocks; avoid unnecessary braces, parentheses, and trailing commas.

```ts
// Bad
if (!data) {
    return "Error processing the request.";
}

// Good
if (!data) return "Error processing the request.";
```

---

## Comments

- Use `//` for single-line comments.
- Use a `/** ... */` JSDoc block to document functions: purpose, parameters, and return value.

```ts
/**
 * Calculates the area of a rectangle.
 * @param width - The width of the rectangle.
 * @param height - The height of the rectangle.
 * @returns The area of the rectangle.
 */
function calculateRectangleArea(width: number, height: number): number {
    return width * height;
}
```

---

## Structure

- Prefer Screaming Architecture: organize folders by feature/domain so intent is obvious from the tree.
- Encapsulate repetitive logic in functions and export them for reuse.
- Avoid barrel files; they hurt build/runtime performance.
- Upload media assets to a global CDN rather than bundling or hotlinking them (use Dymo CDN when working inside Ciphera).

---

## Performance Idioms

- Order runtime checks by real-world likelihood: validate the most probable branch first to reduce average latency.
- Never duplicate identical code fragments across branches.

```ts
// 70% of inputs are emails: test that branch first.
if (REGEX_EMAIL.test(inputData)) {
    // handle email
} else if (REGEX_DOMAIN.test(inputData)) {
    // handle domain
} else {
    // error
}
```

- Prefer specific, tailored solutions over cross-platform abstractions when the latter measurably degrade performance.
