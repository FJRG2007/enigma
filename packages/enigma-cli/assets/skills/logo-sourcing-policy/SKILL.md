---
name: logo-sourcing-policy
description: Source real brand, product, platform, and technology logos instead of fabricating them - search the web and vector-logo registries (Simple Icons, svgl, worldvectorlogo, cdnlogo, Iconify, devicon, the vendor's own brand/press kit), prefer SVG (and optimized WebP for web targets), keep official brand colors, and check contrast so a monochrome logo does not vanish on a matching background. Use whenever adding, embedding, or referencing a logo or brand/technology icon in any project - websites, READMEs, app UI, integration lists, tech-stack badges, social icons, footers, or splash/marketing pages. Color-conflict resolution follows the logo-color-policy setting (ask|adapt-background|adapt-logo).
---

# Logo Sourcing Policy

Models fabricate the logos of real companies, products, platforms, and
technologies: they invent a plausible-looking mark, guess the wrong shape or
colors, or draw an outdated version. A fabricated brand logo is wrong output -
it misrepresents a trademark and looks amateur. This skill's rule is simple:
**never draw a real logo from memory - find the official asset.**

## The Rule

- If a task needs the logo or brand icon of a real entity (a company, product,
  platform, framework, language, tool, social network, payment provider, etc.),
  SOURCE the real asset. Do not redraw it, approximate it, or emit hand-written
  SVG path data for it from memory.
- The only marks you may author are ones that do not exist yet: the user's own
  project logo, a generic/placeholder glyph, or an abstract icon they asked you
  to design.
- When you cannot obtain the real asset (no web access, not in any installed
  package, unclear which variant), ask the user for it or leave a clearly
  marked placeholder. Never fill the gap with an invented logo.

## Where to Source (in order)

1. **The vendor's own brand / press kit.** The authoritative source, and the
   one that respects trademark guidelines. Search "<brand> brand assets" /
   "<brand> press kit" / "<brand> logo svg". Many host a downloadable SVG.
2. **Curated vector-logo registries** (prefer these for breadth and SVG):
   - Simple Icons - `simpleicons.org` (npm `simple-icons`, CDN via jsdelivr) - monochrome brand SVGs, huge coverage.
   - svgl - `svgl.app` - modern, often includes light/dark variants.
   - worldvectorlogo - `worldvectorlogo.com`, VectorLogoZone - `vectorlogo.zone`.
   - cdnlogo - `cdnlogo.com`, seeklogo - `seeklogo.com`.
   - Iconify - `iconify.design` (the `logos` set by gilbarbara, `simple-icons`, `devicon`) - one API for many logo sets.
   - devicon - `devicon.dev` - developer/technology stack logos (languages, frameworks, tools).
   - browser-logos - `github.com/alrra/browser-logos` (the cdnjs mirror) for browsers.
3. **An already-installed icon package** when the project has one - `react-icons`
   (`si`/`fa` sets), `simple-icons`, `@iconify/*`, `lucide`/`devicons`. Reuse it
   instead of fetching a file (dependency-policy owns adding a NEW one).
4. **A general web/image search** as the fallback - but verify you grabbed the
   genuine current logo, not a fan edit, a competitor, or an old version.

Prefer the web when available; you may fetch and inspect these sources. If the
runtime has no web access, drop to an installed package, then to asking the user.

## Format Preference

- **SVG first**, always, when the target supports it: scalable, tiny, and its
  colors are editable in the markup (which the contrast check below needs).
- **For web or WebP-capable targets**, when a raster is genuinely required
  (a photo-real mark, a complex multi-gradient logo, or a surface that cannot
  embed SVG), prefer an optimized **WebP** (or AVIF) over PNG - it is smaller
  and loads faster. Keep a PNG fallback only if the target needs one.
- Never use JPEG for a logo (block artifacts, no transparency).
- Keep the asset at the resolution the layout needs; do not upscale a small
  raster - fetch a vector or a larger source instead.

## Color and Contrast

Placing a logo without checking contrast produces an invisible mark - e.g. the
Apple logo is solid black or white, so a white Apple logo on a white background
disappears.

- When the asset is SVG, READ its `fill`/`stroke`/`stop-color`/`currentColor`
  to learn its real colors. A single-color mark (all one `fill`, or driven by
  `currentColor`) is monochrome and WILL clash with a same-tone background.
- Know the brand's official colors and preserve them; brand fidelity matters.
  Many brands publish a full-color, a solid-black, and a solid-white variant -
  pick the variant that fits the surface rather than recoloring the full-color
  one.
- Ensure the placed logo meets a visible contrast against its actual background
  before shipping it.

When a monochrome logo would clash with its background, resolve it per the
**logo-color-policy** setting (`enigma config logo-color-policy`):

| Value | Behavior |
|-------|----------|
| **ask** (default) | Stop and ask the user how to resolve it - recolor the background, add a container/badge behind the logo, swap to a different brand variant, or recolor the logo. Do not silently pick one. |
| **adapt-background** | Auto-resolve by giving the logo a contrasting container/background (a chip, card, or badge) and KEEP the logo's official colors. Preferred for brand fidelity. |
| **adapt-logo** | Auto-resolve by switching to the brand's opposite monochrome variant (or recoloring the mark) so it fits the existing background. |

The current value is injected into the deployed memory file, so you always know
which mode is active without reading config.

## Trademark Respect

Brand logos are trademarks. Follow the brand's usage guidelines: respect clear
space, do not distort, stretch, or rotate the mark, and do not recolor it beyond
the contrast resolution above (and even then, prefer an official variant). Use
each logo only to identify the real product it represents.

## Boundaries

This skill governs sourcing and placing REAL logos. Designing an original
project logo or a generic icon is normal creative work and is out of scope.
Adding a NEW icon dependency is owned by dependency-policy; visual/layout
design is owned by frontend-design.
