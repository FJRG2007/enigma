---
name: ciphera-style-policy
description: Ciphera code style conventions - mandatory formatting and language idioms for source code (TypeScript-first, applies to every language) - American-English naming, double quotes, string interpolation, length-sorted imports, one statement per module and a namespace import (`import * as ns`) instead of a long named list from a project module, 4-space indentation, comment/JSDoc format, compact single-line blocks, and code-level anti-patterns (barrel files, external CDN/hosting dependencies). Use whenever writing, refactoring, or reviewing source code.
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
- One statement per module: never import the same module twice in a file (a value import plus a `type` import of the same module is still one statement, with `type` on the members).
- When you need many symbols from one of the project's own modules, import the module as a NAMESPACE instead of listing them. A named list is fine for a handful; past that the line stops being readable, and every new export widens it again. The namespace also makes each call site say where the symbol comes from.
- Name the namespace after the module. When that name is already a local variable in the file, pick a distinct one (`conf` for a config module whose values are held in `config` variables, `gateDb` for a `db` module) rather than shadowing it.
- This applies to modules the project owns (relative paths, path aliases). Standard-library and package imports stay named: their surface is fixed and the ecosystem reads them that way.

```ts
// Bad: 13 symbols on one line, and it grows with every new export.
import { readConfig, readGlobalConfig, CONFIG_DEFAULTS, setEnigmaToggle, setEnigmaValue, OUTPUT_STYLES, DASHBOARD_MODES } from "./config";

// Good
import * as conf from "./config";

const { config } = conf.readConfig();
if (!conf.OUTPUT_STYLES.includes(style)) return;
```

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
- Terminate every interface and type-literal member with a semicolon, including the last member of a single-line literal: `type Image = { url?: string; };`.
- The trailing-comma rule covers named import and export lists: `import { a, b } from "x";`, not `import { a, b, } from "x";`.

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

---

## Self-Check (Before Declaring Done)

- These rules are mechanically checkable, so do not trust memory. Before reporting code work complete, lint the files you changed and fix the findings: run the project's lint gate if it has one (an `npm run lint` / `lint:*` script or its pre-commit hook), otherwise `npx @enigmax/linter --strict <changed files>`.
