# @enigmax/icons

Icons for React. 391 icons in 36 categories, each in its own module, so a
bundle carries only the ones it renders.

```tsx
import { IconMapPin } from "@enigmax/icons/bold-duotone";

<IconMapPin className="size-4 text-sky-500" />;
```

## There is no default weight

An icon is always asked for by the weight it is drawn in. No weight lives at
the root and none is the one you get by not choosing: with many weights, "the
default" is an arbitrary winner that every other weight then has to argue with.

```tsx
import { IconMapPin } from "@enigmax/icons/bold-duotone";
import { IconMapPin } from "@enigmax/icons/<weight>";
```

The root carries only what every weight shares: the `Icon` and `IconProps`
types, and the brand marks, which are real logos and have no weight to pick.

**A weight is a build dimension, not a prop.** `<IconMapPin weight="outline" />`
reads friendlier and is the one design this package cannot have: the component
would need every body reachable at runtime, so importing one icon would pull
all of its weights into your bundle and the paragraph below would stop being
true. Two weights of one icon are two imports, and a project that uses one
never downloads the other.

## Only what you use

Every icon is its own module and the package declares no side effects, so an
icon you never import is unreachable code and never reaches your output. The
icon data is not fetched or resolved at install time: the bodies are written
into the source as plain strings by `generate.mjs`, which reads a set once at
build time and keeps only the names listed in `icon-map.json`.

## By category

```tsx
import { IconMapPin } from "@enigmax/icons/bold-duotone/categories/map";
import * as icons from "@enigmax/icons/bold-duotone/categories";
```

Categories come from the set's own taxonomy: `arrows`, `devices`, `map`,
`security`, `ui`, `weather`, and thirty more. Every weight carries the same
categories, since a category is what an icon IS, not how it is drawn.

## Adding a weight

Three steps, and nothing that already exists changes:

1. Add it to `weights.available` in `icon-map.json`.
2. Give every icon its name in that weight under `glyphs`, e.g.
   `"IconSun": { "glyphs": { "bold-duotone": "sun-bold-duotone", "outline": "sun-linear" }, "category": "Weather" }`.
   Names are written out per weight rather than derived by swapping a suffix: a
   set is free to name a weight's glyph anything, and guessing it produces an
   icon that silently renders nothing.
3. `node generate.mjs --set <set.json> --weight outline`.

A weight that is declared but incomplete fails the test suite rather than
shipping: half a weight renders some icons and vanishes the rest, which reads
as a broken page rather than a missing line in a JSON file.

## Conventions

An external link is marked with the **diagonal arrow pointing up and to the
right** (`IconExternalLink`), not the box-with-an-arrow-leaving-it glyph: the
latter reads as clutter at small sizes.

Brand marks (`IconBrandGithub`, `IconBrandDiscord`, ...) are re-exported from
`@tabler/icons-react`, an optional peer dependency, and come from the root
rather than from a weight. This set has no brand marks, and drawing a company's
logo by hand is worse than shipping the real one. Install
`@tabler/icons-react` only if you import a brand mark.

```tsx
import { IconBrandGithub } from "@enigmax/icons";
```

## Regenerating

```sh
node generate.mjs --set <path/to/set.json> --weight <name>
```

Both flags are required: there is no default weight to fall back on. Edit
`icon-map.json` to add, remove or re-point an icon, then regenerate. A name
that is not in the set, or an icon with no name for the weight being
generated, fails the run rather than rendering an empty square forever.

## Licence

MIT.
