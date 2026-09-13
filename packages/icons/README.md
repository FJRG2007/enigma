# @enigmax/icons

Filled duotone icons for React. 391 icons in 36 categories, each in its own
module, so a bundle carries only the ones it renders.

```tsx
import { IconMapPin } from "@enigmax/icons";

<IconMapPin className="size-4 text-sky-500" />;
```

The icons are filled, not stroked: colour comes from the surrounding text
colour (`currentColor`), and the lighter half of each glyph is the same colour
at 50% opacity. There is no line to widen, so `stroke` is accepted and ignored
rather than forwarded into the SVG attribute of that name, which takes a colour
and would paint the icon with an invalid value until it disappeared.

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

## Conventions

An external link is marked with the **diagonal arrow pointing up and to the
right** (`IconExternalLink`), not the box-with-an-arrow-leaving-it glyph: the
latter reads as clutter at small sizes in a filled set.

Brand marks (`IconBrandGithub`, `IconBrandDiscord`, …) are re-exported from
`@tabler/icons-react`, an optional peer dependency. This set has no brand
marks, and drawing a company's logo by hand is worse than shipping the real
one. Install `@tabler/icons-react` only if you import a brand mark.

## Regenerating

```sh
node generate.mjs --solar <path/to/set.json>
```

Edit `icon-map.json` to add, remove or re-point an icon, then regenerate. A
name that is not in the set fails the run rather than rendering an empty square
forever.

## Licence

The icon artwork is the Solar Icon Set by 480 Design, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). That licence
requires attribution: keep this notice, and surface it somewhere in any app
that ships these icons (an About or Credits screen is the usual place).

The package code is MIT.
