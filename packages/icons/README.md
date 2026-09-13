# @enigmax/icons

Icons for React. 391 icons in 36 categories, each in its own module, so a
bundle carries only the ones it renders.

```tsx
import { IconMapPin } from "@enigmax/icons";

<IconMapPin className="size-4 text-sky-500" />;
```

The icons are filled, not stroked: colour comes from the surrounding text
colour (`currentColor`). There is no line to widen, so `stroke` is accepted and
ignored rather than forwarded into the SVG attribute of that name, which takes
a colour and would paint the icon with an invalid value until it disappeared.

## Only what you use

Every icon is its own module and the package declares no side effects, so an
icon you never import is unreachable code and never reaches your output. The
icon data is not fetched or resolved at install time: the bodies are written
into the source as plain strings by `generate.mjs`, which reads the full set
once at build time and keeps only the names listed in `icon-map.json`.

## By category

```tsx
import { IconMapPin } from "@enigmax/icons/categories/map";
import * as icons from "@enigmax/icons/categories";
```

Categories come from the set's own taxonomy: `arrows`, `devices`, `map`,
`security`, `ui`, `weather`, and thirty more.

## Weights

Bold duotone is the weight that ships today, and it is addressable by name:

```tsx
import { IconMapPin } from "@enigmax/icons";               // the default weight
import { IconMapPin } from "@enigmax/icons/bold-duotone";  // the same icon, named
```

**A weight is a build dimension, not a prop.** A `weight` prop would have to
reach every body at runtime, which puts all of them in the bundle for any icon
the app imports and destroys the one thing this package is for. So each weight
is generated into its own directory with its own subpath, and an app pays only
for the weights it actually imports. Two weights of the same icon are two
imports, and a project that uses one never downloads the other.

Adding one is three steps and no breaking change:

1. Declare it in `icon-map.json` under `weights.available`.
2. Give every icon its name in that weight under `glyphs`, e.g.
   `"IconSun": { "glyph": "sun-bold-duotone", "glyphs": { "outline": "sun-linear" }, "category": "Weather" }`.
   Names are written out per weight rather than derived by swapping a suffix: a
   set is free to name a weight's glyph anything, and guessing it produces an
   icon that silently renders nothing.
3. `node generate.mjs --set <set.json> --weight outline`.

The default weight keeps the root paths, so nothing that already imports from
this package changes when a weight is added. A weight that is declared but
incomplete fails the test suite rather than shipping: half a weight renders
some icons and vanishes the rest, which reads as a broken page.

## Conventions

An external link is marked with the **diagonal arrow pointing up and to the
right** (`IconExternalLink`), not the box-with-an-arrow-leaving-it glyph: the
latter reads as clutter at small sizes in a filled set.

Brand marks (`IconBrandGithub`, `IconBrandDiscord`, ...) are re-exported from
`@tabler/icons-react`, an optional peer dependency. This set has no brand
marks, and drawing a company's logo by hand is worse than shipping the real
one. Install `@tabler/icons-react` only if you import a brand mark.

## Regenerating

```sh
node generate.mjs --set <path/to/set.json> [--weight <name>]
```

Edit `icon-map.json` to add, remove or re-point an icon, then regenerate. A
name that is not in the set, or an icon with no name for the weight being
generated, fails the run rather than rendering an empty square forever.

## Licence

MIT.
