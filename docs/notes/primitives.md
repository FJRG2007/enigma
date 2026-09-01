# Component registry: primitives and utilities

Two published packages plus the `enigma add` command that puts them into a project.
They exist so the rules the frontend policy can only *persuade* an agent to follow
become a dependency it can *import*.

- `packages/primitives` -> `@enigmax/primitives`: everything that RENDERS - components
  with no visual styles of their own, plus the behaviour, timing and accessibility
  underneath them.
- `packages/utils` -> `@enigmax/utils`: everything that renders NOTHING - functions and
  state. A cache, a breached-password check.

**The line between them is "does it produce DOM".** toast, relative-time and network moved
out of utils for it: the first two ship components, and network moved with them because a
package split on "UI vs not-UI" put a hook returning data on the wrong side of its own rule
once the other two left. "Primitive" here means what it means in Radix and shadcn - an
unstyled component - so a component belongs in primitives whatever it renders.

Neither package depends on the other, and the move was done in a way that keeps it that
way: the whole item travels, queue and renderer together, because leaving the notification
queue in utils would have made primitives depend on it. There are no re-export shims in
utils for the same reason - a deprecation shim would have created exactly the dependency
this split exists to avoid, so it is a clean break at 0.x.

## Why a package and not a skill

A rule in a SKILL.md is skippable (`skills-are-skippable.md`) and a rule in the
memory kernel costs tokens on every task. A dependency is neither: the behaviour
is in the project's `node_modules`, versioned, and typechecked. The doctrine in
`rules-are-persuasion.md` applied to the user's runtime rather than to ours.

The corollary: a primitive is only finished when its guardrail rule exists too.
Without the rule, an agent keeps hand-rolling the thing and the package changes
nothing.

## Architecture

Framework-agnostic core, thin adapters. One rule: the core never assumes a
framework and never touches a framework's DOM behind its back.

```
src/core/<name>.ts    plain factory: create<Name>(...) -> instance with subscribe/destroy
src/react/use-<name>  a hook over the core
src/index.ts          package entry (core)
src/react/index.ts    package entry (react)
```

The copy-count negotiation is the pattern to reuse when a primitive needs to
create DOM: the core either owns it (`copies: "clone"`, for vanilla and Astro) or
reports what it needs through a callback and lets the framework render it
(`copies: "external"`, for React). Cloning behind React's back is undone on the
next render.

Vue, Svelte and TanStack adapters are not written yet. They reuse the same core;
Astro already works today through the vanilla entry.

## Theming without styles

A primitive sets only what the behaviour requires - `overflow`, `touch-action`,
`user-select`, `will-change`, `transform` - and nothing that is a look. State is
published as data attributes so a theme package can style it later without the
primitive knowing a theme exists:

`[data-enigma-marquee]`, `[data-dragging]`, `[data-hovering]`,
`[data-reduced-motion]`, `[data-enigma-marquee-track]`, `[data-enigma-marquee-copy]`.

`manageStyles: false` hands even the functional styles back to the consumer.

Registry entries carry `styles: false` and a `themeHooks` list, so the future
theme package can be generated from the registry rather than hand-maintained.

## marquee

The whole contract is **speed in px/s, never a duration**. A duration makes the
speed `content / duration`, so the row accelerates as items are added. Measured:
a 50s rail ran at 45, 67 and 87 px/s at 10, 15 and 20 items.

Twelve rules are encoded in `core/marquee.ts`, each commented with the bug it
prevents. The three that cost production incidents:

1. `setPointerCapture` retargets the compatibility mouse events, so every link in
   the row silently stops opening. Bind to `window` instead.
2. `touch-action: none` steals the page scroll on a phone. It must be `pan-y`
   (`pan-x` when vertical).
3. A hover handler that ignores `pointerType === "mouse"` sticks at the hover
   speed forever after the first tap, because touch never fires `pointerleave`.
   That gate alone is NOT sufficient and the shortfall is platform-dependent:
   Chromium follows a touch with compatibility pointer events carrying
   `pointerType: "mouse"`, and it emits them on Linux but not on Windows. The
   naive gate therefore passed every local run and failed in CI. A touch now
   also opens a 1s hover-suppression window (stamped from `touchstart`, which
   arrives before the compatibility events), and `pointerleave` clears the state
   whatever the pointer type. The regression test dispatches the fake mouse
   enter itself, so it reproduces on any platform rather than only on the one
   that happens to emit it.

**Hover is ONE option, not a family of flags.** `hover` takes `"off"` (the default),
`"pause"`, a number that multiplies the cruise speed, or `{ speed }` for an absolute px/s
whose direction still follows `reverse`. It replaced `hoverScale`, which could only ever
express a multiplier - "stop", "go faster" and "an exact speed" all had to be encoded as
one, and `0` meaning pause was a convention rather than a type. A discriminated union says
what it means and the compiler checks it.

The rest: measure the lap from `copies[1].offsetLeft - copies[0].offsetLeft`
(never compute it from item widths); `max(2, ceil(lane / period) + 1)` copies,
recomputed from a `ResizeObserver` and after `document.fonts.ready`; one rAF loop
rather than CSS keyframes; one integrator
(`velocity += (target() - velocity) * (1 - decay ** dt)`) for cruise, hover and
momentum, so none of the three can arrive as a cut; `target()` read live every
frame; drag past ~6px cancels the click in the capture phase; right click never
drags; a pointer still for ~90ms throws nothing; reduced motion drops autoplay
and keeps the drag; `dt` clamped to 0.05 so a backgrounded tab does not teleport
the row.

In clone mode the copy count must be reconciled against **the DOM**, not against the
previous count. `copyCount` starts optimistically at 2 while the markup ships one copy,
so keying the clone on "the count changed" left every row whose content already fills
the lane - the common case for a logo wall - with a single copy and a visible gap. It
survived the first release because the suite's own link tests only passed WHILE the
clone was missing: with one copy their `getByTestId` locators were unambiguous. Scope a
locator to the source copy (`getByTestId("copy").first()`), or a test will quietly
depend on the bug.

The spin-up is a consequence of the shared integrator: `0.12^t` leaves under 1%
of the gap after ~2.2s, so a test that samples the cruise speed must wait that
long or it measures the ramp. Two tests were written wrong this way first.

### Verification

`packages/primitives/test/` drives real Chromium and samples
`new DOMMatrixReadOnly(getComputedStyle(track).transform).m41` per animation
frame - never the engine's own state. `test/measure.ts` holds the sampler,
the wrap correction (a delta past half a period is the loop, not a jump) and the
first-samples discard.

Playwright's `test.use({ reducedMotion: "reduce" })` did NOT apply under the
project's device descriptor here; the emulation is done with
`page.emulateMedia()` in the test, and the test asserts the emulation is on so it
cannot become a false pass. Same class of trap as the brief's warning that a
link assertion proves nothing when the DOM has no links.

## logo-marquee

A RECIPE, not a primitive: it has a look and the look is the point. `<LogoMarquee logos={...}>`
takes a URL, or a tagged union per item - `{ kind: "img", src, alt? }` or
`{ kind: "node", node }` - because some of the logos in any real wall are set in type
(Bloomberg, NASA, Harvard) rather than drawn, and the rest are usually just a path. The
three forms mix in one list; a bare URL carries no `alt`, because one guessed from a file
name is a fabricated one and a wrong alt is worse than an empty one. The API shape comes from performativeUI's LogoMarquee; the timing does not.

**Their `speed` is seconds per loop.** That is the exact defect the marquee exists to
prevent: a lap is as long as its content, so a duration makes the speed content/duration and
the row runs faster every time a logo is added. Ours stays px/s.

Two things a logo wall needs that a marquee does not: one optical height for images that
arrive at a dozen aspect ratios (never stretched - the ratio of a logo IS the brand), and
`tone="mono"` to drain the colour so twelve palettes stop competing, restored on hover.

### The runaway this exposed

A marquee lane whose width comes from its own CONTENT feeds back: more copies make the lane
wider, a wider lane needs more copies. The playground pane centres its items, which sizes
them to max-content, and the lane measured 18,326px and asked for 25 copies of seven logos.

Three changes, in the order they matter:

1. `requiredCopies` is CAPPED. The zero guard did not catch this because the width was not
   zero - a row of images measured before they load is a few pixels wide, and lane/period
   then asks for hundreds of copies. In React that renders hundreds of subtrees before the
   images arrive to correct it, which trips React's update-depth limit and takes the page
   down with error #185. The cap turns a dead page into a wasteful render, which is the
   difference between a bug and an outage.
2. The core now **re-measures when an image finishes loading**. The ResizeObserver watches
   the first copy, but only while that exact node survives - a framework re-rendering the
   copies replaces it - so the images are waited on directly, `error` included, since a logo
   that 404s still settles the layout it was holding open.
3. The recipe's lane declares `width: 100%; min-width: 0`, and says why in a comment. Never
   `loading="lazy"` on a marquee image either: the row measures its lap from the rendered
   width, and a lazy image has none.

## One entry per component, not one entry for the package

`@enigmax/primitives/react` exports everything and is still the convenient import, but every
component ALSO has its own entry - `/react/input`, `/react/palette`, `/react/button`. That is
the shape Radix ships, and the reason is measurable rather than stylistic.

A barrel is only as tree-shakeable as its least pure module. Enough of what a component
library does at module scope reads as a side effect to a bundler - `forwardRef(...)`,
`createContext(...)`, `lazy(...)`, `SearchPalette.Root = PaletteRoot` - and one of those
keeps the whole chunk alive. Measured on a form of two text fields, importing from the
barrel: **20.8 KB before the split, 4.5 KB after**, with no palette, no password estimator
and no search engine in it. The barrel improved too, because it is now a re-export of small
modules rather than one fat chunk.

`sideEffects: ["*.css"]` in the manifest is the other half: without it a bundler must assume
every module might do something on import and keeps them all. The CSS recipes are listed
because a stylesheet IS a side effect, and dropping one leaves a component styled by nothing.

## asChild: the escape hatch that decides whether a package is usable

`Slot` (`react/slot.tsx`) is Radix's, deliberately - the semantics are the ones a React
developer already knows. A component that always renders its own `<button>` forces anyone
who needs a `motion.button`, a router `Link` or their own design system's button to
reimplement the behaviour, and that is the moment a team stops using the package.

Its rules, and why each is the way round it is: the CHILD's props win, because the child is
what someone wrote by hand at that call site; event handlers are CHAINED, ours first, since
dropping ours takes the behaviour with it silently (the exact failure `onClick` on the Button
cost once); `className` and `style` are merged; refs are composed.

`<Button asChild>` does not inject its shortcut badge, because a slot takes exactly one child
and a second one throws. `state.shortcut` from `useButton` is how a custom render places it.

## input

**React gets a component, not a hook over a DOM mutator.** `<Input>` renders the field, its
buttons and the meter itself; `createInput` is the adapter for pages that are not React.
The imperative version injecting buttons next to a field React owns meant two writers on
one subtree - which is exactly what made the wrapper feel wrong to work with, and the
reason the API now leads with `<Input {...props} />`. The shared parts (the icon paths, the
generator, the estimator) live in core and both renderers use them.

Nothing switches on by itself except the reveal. `generate`, `strength` and `breach` are one
prop each and off until asked for, because they belong on registration and change-password
forms and are noise on a sign-in.

- **A generated password is written the way a keystroke would be.** Assigning `input.value`
  is invisible to React - it compares against the last value it rendered and skips the
  change event - so the value goes through the prototype's setter followed by a bubbling
  `input` event. That is what makes the generator work with a controlled field, an
  uncontrolled one and a form library without knowing which it is in. Tested by breaking it.
- **`crypto.getRandomValues`, never `Math.random`**, and the index is drawn by rejection
  rather than `% length`, which is biased. No CSPRNG means an exception: a generator that
  quietly produces predictable passwords is worse than one that refuses, because nothing
  downstream can tell.
- **The meter reports, it does not decorate.** Score, bits and warnings come out of a pure
  estimator; the component renders five segments and a `data-score`, and the recipe owns
  red-through-green. The bands are a convention, not a measurement, and say so - swap the
  estimator for zxcvbn where the number has to mean something.
- **`userInputs` is the check no character-class rule makes.** `Ada@example.com1!` has four
  classes and sixteen characters and is guessable by anyone looking at the form.
- **The breach check is a prop**, not a built-in, because it makes a network request. It is
  debounced and aborted on the next keystroke, so an answer about a password three
  characters old can never overwrite the current one. The component reports `data-breached`
  and a count and stops there: a breach is a warning in one form, a hard block in another,
  and each form already renders that its own way.

**One component keyed on `type`, because that is what HTML is.** `type` is an attribute of a
single element, so `<Input type="password">` and `<Input type="search">` are one component -
what differs is which PROPS exist, and that is a discriminated union: `strength` on a text
field is a compile error rather than a prop that silently does nothing. Radix splits Select,
Checkbox and Slider into their own primitives because those are composed WIDGETS rather than
an `<input>`; the same reasoning puts the command palette in its own component and keeps the
field as one.

**Each type loads its own machinery.** `react/input/index.tsx` is the field, its buttons and
the reveal, and nothing else. `password.tsx` (estimator, meter, breach watcher) and
`search.tsx` (the engine) are separate modules pulled in with `lazy()` the moment a type that
needs them is used, and the generator is imported on the first press of its button. A form of
text and email fields therefore downloads none of it. Nothing may re-export a value from those
chunks through the field: a static edge is exactly what stops a chunk being a chunk, and the
bundler folds it straight back in. The types are re-exported freely, because a type is erased.

The icons moved to `core/input-icons.ts` for the same reason - importing two arrays of path
data from `core/input.ts` put the whole imperative vanilla renderer into every React bundle.

`createInput(field, options)`. A `type="password"` field gets a reveal toggle; the icon,
the labels, the side and the container are all replaceable, and the built-in is expressed
as an ordinary `InputAction` so passing one named `"reveal"` replaces it outright.

Four things the hand-rolled version gets wrong, each with a test:

1. The toggle must be `type="button"`. A bare `<button>` inside a form defaults to
   submit, so looking at your password posts the half-filled sign-in form.
2. Pressing it must not pull focus out of the field. `preventDefault()` on `mousedown`
   keeps focus where it is; keyboard users still tab to the button and keep focus there.
3. **The caret.** Assigning `input.type` INSIDE a click handler resets the selection to 0
   in Chromium - and does not when the same assignment runs outside an event. Worse, the
   reset lands one MACROTASK later: the value is still correct in the handler and in a
   microtask. So the selection is captured before the switch, restored after the render,
   and restored once more from a `setTimeout(0)`. Reproduced in twenty lines with no
   library before any of it was written.
4. An invisible action is REMOVED from the DOM, never `hidden`. The hidden attribute
   works through a UA `display: none`, and any author rule setting `display` on the
   button beats it - which a theme styling these buttons always does. A headless
   primitive cannot rely on a UA default its consumers are expected to override.

`destroy()` puts a revealed field back to `password`; leaving it as text would show the
value to whoever sees the screen next.

## palette

The Ctrl/Cmd+K panel. A DIALOG, which is why it is its own component rather than a prop on
the search field: a palette is a trigger, an overlay, a focus trap, a listbox and a footer,
and what makes those usable together is composition. `SearchPalette.Root` and its parts are
the anatomy; `<SearchPalette>` is those parts in the order they belong in.

The design is generalised from the Polaris command palette, which is where the decisions
below were paid for once already:

- **One flat keyboard sequence across every group.** `groupRows` keeps each row's flat
  position, so a group boundary is invisible to the arrow keys. A renderer that grouped into
  separate arrays would have to reconstruct that sequence, which is where an off-by-one makes
  Enter open the row above the highlighted one.
- **The highlight wraps.** In a short list the row after the last one is the first, and an
  arrow key that does nothing at the end reads as a frozen panel.
- **A shorter list pulls the highlight back.** Otherwise it sits past the end and Enter opens
  nothing, which is the single most common palette bug.
- **The caret stays in the field.** The arrows move a highlight somewhere else, so the row is
  announced through `aria-activedescendant`; focus never leaves, and without that attribute a
  screen reader hears nothing move.
- **The pointer moves the SAME highlight.** Two highlights on screen is what makes a palette
  feel unpredictable, because Enter then opens the row the mouse is not on.
- **Opening clears the query.** A palette that comes back holding the last search is one you
  have to empty before using, and it hides what an empty query is for - the recents, which are
  the shortcut on the second visit.
- **Closing hands focus back to the trigger**, or dismissing with Escape drops the visitor at
  the top of the document. The scroll lock compensates for the scrollbar width, since hiding
  it without that shifts the whole page.
- **Recents are guarded end to end** (`core/palette.ts`): storage throws in a private window,
  when the quota is full, and on a file URL, and a palette that cannot remember is still a
  working palette. They are read on OPEN rather than on mount, because another tab may have
  written since.

## select

A listbox that replaces `<select>`, because the native one cannot hold an icon, a second
line, a checkbox or a tag, and its popup is drawn by the OS - unstylable and different on
every platform. `core/select.ts` is the arithmetic (selection, filter, highlight),
`react/select/` is the rendering, and `<Select>` is the parts in the order they belong in.

What it costs to replace the native element is everything the platform was doing for free,
so all of it is deliberate here:

- **The filter is the search core**, with `empty: "all"` and `debounce: 0` - the opposite of
  a search field on both counts. An empty query in a select means every row, and the data is
  already in memory, so a debounce is only the list lagging behind the field. It reads the
  label, the description, the group and `keywords`, and Fuse arrives the same way it does
  everywhere else: a constructor the caller passes, never a dependency.
- **`searchable="auto"` is a count** (`SEARCHABLE_FROM = 8`). Filtering a list of three is a
  bigger panel for nothing; filtering a list of two hundred is the only way to use it.
- **A disabled row is listed, announced and unreachable** - `enabledIndex` walks past it at
  most once around the list, so every-row-disabled leaves the highlight at -1 rather than
  spinning, and `select()` refuses the value even when a click gets through.
- **Typeahead**: one letter walks through the rows that start with it, a longer buffer
  refines instead of jumping. Six hundred ms, then the buffer resets. Without it a select
  with no filter is slower than the native one it replaced.
- **The value is a list internally**, and `multiple` decides what is reported outwards. That
  is what makes one state machine serve both modes; the React layer narrows the types per
  mode so a call site never widens them back by hand.
- **`name` renders a hidden input per value.** A select that only exists in React state
  cannot be submitted by the form it sits in, and that is where it usually sits.
- **The panel measures before it opens.** `data-side="top"` when the space below is smaller
  than the panel and the space above is larger - near the bottom of the window the list is
  otherwise unreachable.

Two defects that are easy to reintroduce, both fixed with a comment in place:

- **The open flag is React's; the instance follows it.** Comparing the two directly reads
  the one render where React has opened and the core has not caught up, and closes the panel
  a frame after it opened. Only the TRANSITION counts (`wasOpen`), and `setOpen` drives the
  instance synchronously so that whatever the same handler does next - a typeahead, a move -
  runs against a panel that is already open.
- **The options effect compares CONTENT, not identity.** `options={[{ ... }]}` is a new array
  of new objects on every render: pushing it in on identity emits a new state, renders again,
  and never stops. The signature is `JSON.stringify` of the data fields; React nodes are
  excluded because an icon element is never equal to the one before it. Same for `value`,
  which is an array literal in `multiple` mode. There is a browser test for the loop.

**The caret and the × share one slot.** `[data-enigma-select-indicator]` is a grid cell
holding both, swapped on hover and focus (`:focus`, not `:focus-visible` - a tap focuses the
button and a touch screen has no hover). Side by side they are two targets a pixel apart,
one of which discards the selection, and the pair changes the trigger's width the moment a
value appears. The caret is `pointer-events: none`: its rotation gives it a stacking context,
which paints it over the × sharing the cell and swallows the click. `data-clearable` on the
trigger scopes the swap, or hovering a select with nothing to clear would hide its caret and
leave an empty slot.

**An empty string is nothing chosen** (`toList` filters it out). `value=""` is how React
writes an empty controlled field and how HTML writes a placeholder option; kept as a value it
leaves the select showing its placeholder while holding something - a clear button for
nothing, and an empty entry posted with the form.

**What the empty state quotes is cut** (`shortenQuery`, 32 characters). Every empty state
puts the query back on screen and a pasted string with no spaces has no break opportunity at
all, so it stretches the panel and keeps stretching it. Cut in the TEXT and not only in CSS,
because `text-overflow` needs a bounded box and the box is what the string is stretching -
the panel's `max-width` and `overflow-wrap: anywhere` are the second half of the same fix.

**A long list is rendered a window at a time** (`SelectList`, `chunk = 40`). A select of
every country is 250 rows and 250 flags for the seven anybody sees, which is what made the
panel slow to open. The window grows on scroll through an IntersectionObserver sentinel, and
immediately to `active + OVERSCAN`, because the keyboard reaches row 200 without scrolling
at all. No observer -> render everything: slower to open beats unreachable rows.

**It ships a theme**, like the toast and for the same reason: an unstyled popup is not a
plain-looking control, it is transparent text lying on top of the page. The sheet lives in
`react/select/styles.ts`, is injected once and PREPENDED to `<head>`, and is generated into
`recipes/select/styles.css` by `scripts/sync-recipes.mjs` (checked in CI, so the two cannot
drift). `styles={false}` opts out; every colour and distance is a `--enigma-select-*`
property, and the docs site maps them onto its own palette in `global.css`.

`className` on `<Select>` goes to the ROOT, not the trigger: the root is the element with a
size and the trigger fills it. `triggerProps` dresses the button.

## search

The recipe kills WebKit's `::-webkit-search-cancel-button`. `<Input type="search">` renders
its own clear button, so the platform's is a SECOND cross - drawn by no other engine, which
makes it a control half the visitors see and the other half never do. The same reset is in
`apps/web/src/styles/global.css` and in the dashboard, where it was on one class and is now
on every search field.

`createSearch(options)`. Debounce, ranking, cancellation and the field wiring; the
matching is pluggable in three layers:

- nothing -> built-in accent-insensitive substring matcher, zero dependencies. `"cafe"`
  finds `"Café"`, and a title hit outranks a body hit.
- `fuse` -> pass Fuse.js's CONSTRUCTOR and get fuzzy matching. `fuseOptions` is forwarded
  verbatim, so every Fuse option behaves exactly as its own docs say.
- `matcher` -> replaces the engine entirely and wins over `fuse`.

**Fuzzy is the default, through a second entry point.** `@enigmax/primitives/search`
statically imports Fuse and pre-fills the `fuse` option; the main entry stays
dependency-free so the marquee and the input never drag a search engine into a bundle.
That split is deliberate: a dynamic import inside the core would either fail to resolve
at build when Fuse is absent, or fail to bundle when it is present, and there is no
version of it that behaves in both a Node consumer and a browser one. A separate,
statically analysable subpath has neither problem.

`enigma add search` installs `fuse.js` alongside the package. Registry items may declare
`dependencies`, and both the dependency and the copy paths install what is missing - a
copied recipe imports its engine, so the dependency has to travel with the source.
`--no-deps` adds the primitive alone, for a project that wants the substring matcher and
no engine.

**Installs run through the PROJECT's package manager, never a hardcoded npm.**
`detectPackageManager()` reads the corepack `packageManager` field first (a declaration
beats a trace), then searches upwards for a lockfile so a workspace package finds the one
at the monorepo root. The verb differs too: npm uses `install`, pnpm/yarn/bun use `add`.
Running npm inside a pnpm or bun project writes a second lockfile and leaves the tree in
a state the project's own tooling disagrees with, which is the bug the first version
shipped with.

Fuse is an OPTIONAL peer dependency, never a real one: the package's zero-dependency core
is what lets the marquee and the input be installed without dragging a search engine in.
The constructor is passed rather than imported so nothing is bundled unless it is used.

Fuse indexes on construction, so the engine is rebuilt in `setItems`/`update` and never
per keystroke. `limit` applies to the empty-query branch too - a caller asking for 10 rows
means 10 rows, and "show everything" is the longest list of them all.

## flags

**The emoji flag is what this replaces, and the reason is not taste.** A flag emoji is a
pair of regional-indicator code points, and Windows has never shipped a glyph for that pair
in Segoe UI Emoji - it renders as the two bare letters ("ES") for the largest desktop
platform there is, and every platform that does draw one draws a different one. There is no
font stack that fixes it, so the fix is an image. The guardrail `ui-no-flag-emoji` is the
enforcement half; this is the thing it points at.

Three sets, all SVG, all served by ENIGMA itself over a CDN (`assets/flags/<shape>/<code>.svg`
in this repo, refreshed by `scripts/vendor-flags.mjs`, 948 files and 4.1 MB). The artwork was
vendored for one reason: a component whose default source is somebody else's repository
breaks when that repository moves, renames a branch, or goes away, and enigma cannot promise
anything about a URL it does not control. Provenance lives in the vendor script and in
`assets/flags/NOTICE`, which is where a licence notice belongs - not in the API, the docs or
the URLs.

- **The source is one decision, taken once.** `configureFlags({ source: "local" })` at
  startup moves every flag on the site off the CDN; no call site mentions where an image
  comes from. `source` takes `"cdn"`, `"local"` or a base URL, and the local layout
  (`<base>/<shape>/<code>.<format>`) is exactly what the downloader writes, so a mirror of
  your own is the same string with a different host.
- **`png`/`webp` cannot come from the CDN**, because the artwork is stored as SVG. Asking
  for one is downgraded to SVG with a single dev warning rather than a 404 - one warning per
  process, not one per flag, or a list of 200 prints 200 times. The raster formats are for a
  LOCAL set, where `enigma add flags --flags local --flag-formats webp` rasterises what it
  downloaded.
- **The accessible name is AUTOMATIC**, from `Intl.DisplayNames`: the country's own name in
  the reader's language, with no table of 250 names to ship and none to go stale. `label`
  replaces it, `decorative` drops it. Nothing is invented - a subdivision such as `gb-eng` is
  England, and falling back to its region would announce "United Kingdom", so it renders as
  decoration instead. The React component sets `suppressHydrationWarning` for the same reason
  the relative timestamp does: the name is written in the runtime's language, and a server
  and a browser can legitimately disagree about which one that is.
- **A BCP 47 tag is read by its casing, before anything is lowercased.** `es-ES` is a locale
  and means the flag `es`; `es-ct` is a subdivision both sets publish and means the file
  `es-ct`. Lowercase first and those two are the same string, and then one of them is always
  wrong. An emoji flag is accepted as a `code` and converted, which is what makes migrating
  an existing picker a rename of the component.
- **An unresolvable code renders nothing, never a broken image.** A 404 with no alt beside a
  country name is worse than no flag.
- **`label` has no default and no fallback.** Without one the flag is decorative (empty alt,
  `aria-hidden`), which is right beside a country name that is already on screen. A name is
  never derived from the code: "ES" in a screen reader is not a country, and a name guessed
  in the reader's wrong language is worse than silence.

### The downloader (`enigma-cli/src/flag-assets.ts`)

Runs from `enigma add flags` when the answer is `local`, and only then - the primitive needs
none of it. The codes come from `assets/flags/index.json`, shipped beside the artwork, rather
than from a list in the source: a hardcoded country set goes stale the first time a
subdivision is added, and a stale list is invisible, because the download simply never
fetches the flag nobody noticed was missing. A fixed pool of 12 workers rather than a `Promise.all` over a thousand fetches,
which opens a thousand sockets and gets rate-limited into failing. `sharp` is resolved from
the PROJECT and never installed behind the user: without it the SVGs are still written and
the shortfall is reported, because a silent half of what was asked for is the worst outcome.

## cache and notifications

`cache`: the in-flight dedupe matters more than the TTL. Rejections are never
cached; a storage quota error never breaks the read path. Prefix invalidation is
`invalidate("user:*")`.

`notifications`: timers HOLD on pause rather than run, and a hidden tab pauses
automatically - otherwise every queued message fires the instant the visitor
comes back and none of them is read. Eviction never removes a sticky error.

Both guard `typeof document === "undefined"`: `document?.x` still throws a
ReferenceError under SSR, which is how the first version broke in Node.

## Styling: the primitive has none, the recipe does

The core primitives ship **no styles and never will**. Putting Tailwind classes inside the
engine would break every project without Tailwind and tie a behaviour package to a CSS
framework's major version; being styleless is what makes them usable in any design.

The styling lives one layer up, in `recipes/`, and only ever reaches a project through
`enigma add --copy`:

```
recipes/<name>.tailwind.tsx   a complete styled component, utility classes
recipes/<name>.css.tsx        the same component against class names
recipes/<name>.css            the stylesheet it imports
```

A registry file entry with no `style` is the headless part and is always written; one that
names a style is written only for that style. `--style tailwind|css|none` forces it, and
the default comes from `detectStyle()`, which reads the project: `tailwindcss`,
`@tailwindcss/vite` or `@tailwindcss/postcss` in the manifest means Tailwind, anything
else means plain CSS. **Tailwind is the default only where the project has it** - writing
utility classes into a project without Tailwind produces a component styled by nothing,
which is worse than the CSS variant.

`cache` has no recipe on purpose: it renders nothing, so there is nothing to style.

### The Tailwind v4 trap the marquee recipe warns about

Tailwind v4 writes `translate-*` to the CSS `translate` property, which **composes with**
`transform` rather than replacing it. The marquee engine drives the track's `transform`
every frame, so a `translate-x-*` utility on that element does not override it - the two
add up and the row drifts. Anything that needs offsetting goes on the lane or on an inner
element, never on the moved one. Both marquee recipes carry that warning at the top of the
file, where someone editing the classes will actually read it.

## toast

**Vendored, not written here.** `src/react/toast/` is the toast from dymo-saas (itself a
Sonner derivative), kept as close to verbatim as a library can keep it, with its NOTICE
beside it. The reason is not laziness: a second toast that merely resembled the first would
be a different thing on every screen these projects put in front of somebody, and "looks
about right" is exactly the failure that gets reported and never reproduced.

Three mechanical changes, and they are the only ones: `@/utils/cn` became a local two-line
file (a package cannot resolve a consumer's path alias), `import "./styles.css"` became an
injected string (a package cannot assume a CSS-capable bundler), and `JSX.Element` became
`React.JSX.Element`, which is where React 19's types put it. Refresh from upstream rather
than editing in place.

**It is one of two components here that ship a look** (select is the other). Everywhere
else a missing stylesheet gives you something unstyled you can see and fix; a toast renders
at the edge of the screen, stacked and animated, so the same omission gives you a pile of
text in a corner - and "remember to import the CSS" is a footgun for something that appears
once every few minutes.
The sheet is injected once and PREPENDED to `<head>`, so anything the document already has
outranks it by source order without a single `!important`. `styles={false}` opts out, and
`@enigmax/primitives/toast.css` is the same sheet, generated from the same module by
`scripts/sync-recipes.mjs` and checked in CI, so the injected and the imported one cannot
drift.

**The queue still works.** `useNotifications().notify()` predates the vendored component, so
`<Toaster>` subscribes to the queue and forwards each item into it, keeping one stack rather
than two competing ones. The forwarded toast is given `duration: Infinity` on purpose: the
queue owns the countdown, and leaving both timers running would let the shorter of the two
win at random. `queue={null}` unsubscribes for anyone who only wants `toast()`.

## network

`createNetworkMonitor()` / `useNetworkState()` in utils, not primitives: connection state
is the environment, not an interaction.

The part worth having in a package is the **transition**, not the raw readings. "You are
back online" has to know the connection had dropped, and every implementation of that ends
up as a stray `wasOffline` boolean beside the effect - re-derived per screen, and wrong on
a page that loads offline. `recovered` is tracked in the monitor and is false on a first
load, so a page that opens online never announces a comeback that never happened. `slow`
is the other derived signal: 2g or slower, or data saver on.

Three details the naive version misses: the Network Information API is still prefixed in
some browsers and absent in Safari, so the connection object is looked up three ways and
may be null throughout; the `change` event fires for readings that did not change, so the
snapshot is shallow-compared before any subscriber is told; and a server render must
report ONLINE, because assuming offline flashes a warning on every page.

Deliberately no toast. The monitor reports state and the notification queue renders it -
binding them inside the primitive would make it useless to anyone with their own toaster.

## button

**React gets `<Button>`, same as input.** `<Button onPress={save}>Save</Button>` is the whole
call site. The hook shipped first and it was the wrong thing to lead with: rendering an
ordinary button through it means six lines of hook, spread and state juggling at every call
site, which is exactly how they drift apart. `useButton` stays for markup that is not a
button - a card, a table row - and the component is what the docs open with. The element is
still reported rather than chosen.

**Links: the import path is the configuration.** `@enigmax/primitives/next` re-exports
everything with `Button` bound to `next/link`, so an href is a client navigation with
nothing at the call site and nothing to register. A subpath is only ever resolved by a
project that has Next, which is what makes it safe: a static `import Link from "next/link"`
in the main entry is a build error for every consumer on Vite, Astro, Remix or plain React.
`@enigmax/primitives/react-router` is the same thing for React Router, and it also
translates `href` to that router's `to`, so a call site writes `href` whatever is underneath.
A new router is a new entry, which is the only shape that costs the consumer nothing.

React Aria solves it the other way - a `RouterProvider` taking the router's `navigate`,
which covers every router with one mechanism and always renders a real anchor, at the cost
of a line of setup. `setLinkComponent` is this package's version of that, for a router with
no entry yet; `as` is the per-link escape. Neither is what a Next or React Router app should
be writing.

The Next entry is exercised end to end in the browser suite by aliasing `next/link` to a
stub at bundle time, so the wiring is tested without a Next runtime in a Playwright page. `type="button"` is the default, so an action button never posts the form it
sits in.

The lesson generalises and had to be applied twice before it stuck: a headless package
shipping only hooks pushes the same boilerplate into every consumer. Ship the component, and
keep the hook for the cases the component cannot cover.

Disabled, loading and a cooldown are three reasons for ONE state, so they collapse into
`available` rather than three flags every call site has to combine correctly. The element
is REPORTED (`"a"` when there is an href, else `"button"`), never chosen: a
framework-agnostic package cannot import `next/link`, so the recipe picks `Link` or `<a>`
from what the primitive says.

Decisions worth keeping:

- **The cooldown starts when async work FINISHES**, not when it was requested. Starting it
  at request time lets a slow call eat its own cooldown and the button is free the instant
  it returns.
- **A keyed cooldown persists**, because without it a refresh is a free retry - which is
  the entire thing a cooldown exists to prevent. A stored time in the past is finished,
  not pending.
- **A shortcut is refused while typing** (input/textarea/select/contenteditable) and
  whenever any modifier is held, so it never steals a real shortcut or types into a field.
- **`onClick` is an alias of `onPress`, not a second handler.** React's name had been
  omitted from the props, so in TypeScript it was an error and in plain JS it landed in the
  rest spread AFTER the component's own handler - replacing the one place a press is refused
  while loading, disabled or cooling down, and taking the behaviour with it silently. The
  click event is now passed through to the handler too; `press()` used to be called bare.
- **An anchor cannot be `disabled`**, only `aria-disabled`, which is advisory - so the
  click handler refuses the press itself rather than trusting the attribute.

## toast

`<Toaster />` in utils, over the notification queue that was already there. Deliberately NOT
a dependency on sonner or a vendored fork of one: the queue owns ordering, dedupe by key,
sticky errors and timers that hold while the tab is hidden, and pairing it with a second
library's store would mean two things deciding when a message disappears.

The renderer adds the four things a queue cannot express:

- **A toast that is leaving is still on screen.** The queue drops an item the moment it is
  dismissed, so the component keeps its own list and holds the node for `exitDuration`
  before removing it. Without that the stack jumps and nothing can animate out.
- **A pointer resting on the stack stops every clock** (and focus does too), so a message
  cannot expire while it is being read.
- **A swipe follows the finger before it decides anything**, only towards the edge the stack
  is pinned to, and springs back under the threshold. `--enigma-toast-swipe` is published as
  a custom property so the transform stays the stylesheet's decision - and the transition is
  dropped mid-drag, because a lagging toast reads as a broken gesture.
- **An error interrupts; everything else waits its turn.** `role="alert"`/`assertive` for
  errors, `role="status"`/`polite` otherwise.

The stack is seeded from the queue rather than from an empty list, so a `notify()` that
happened before the Toaster mounted - during a redirect, or from a module that runs early -
is not invisible for a frame.

`promise()` and `update()` went into the core for this. One async action is ONE toast that
travels from loading to its outcome in the same slot; the alternative is three stacking up.
`promise()` rethrows, because swallowing the rejection would turn a failed call into a
silent success for everything after the await. `update()` patches in place rather than going
through `notify()`, which dedupes by KEY - a notification raised without one would be
appended as a second toast instead of replaced.

The default theme is called **Ember** and is entirely in `recipes/toast/styles.css`: custom
properties at the top are the whole API, and overriding them on `:root` is a new theme
without touching a selector. `loading` is sticky by definition, since it ends when the work
does.

## password-breach

`checkPasswordBreach(password)` in utils. Have I Been Pwned's range API is k-anonymous: the
password is hashed with SHA-1 in the browser, the FIRST FIVE hex characters of that hash are
sent, and the service returns every suffix it knows under that prefix. The match happens
locally. The password and its full hash never leave the machine, so the service cannot know
which one was asked about. SHA-1 is protecting nothing here - it is the index the corpus is
published under.

- `Add-Padding: true` by default: without it the response SIZE narrows down which prefix was
  requested, which is the one thing the k-anonymity model still leaks.
- **A padded response carries decoy entries with a count of 0**, indistinguishable from a
  real line except by that zero. Matching on the suffix alone reports every padded response
  as a breach.
- Range responses are cached for five minutes, so typing costs one request per distinct
  prefix rather than one per keystroke.
- **A failure throws.** Rounding a failed check down to "safe" is the one outcome that must
  not happen quietly. An abort stays an `AbortError`, so a component cancelling on the next
  keystroke does not surface a network error.
- No WebCrypto (an http:// page) throws `insecure-context` rather than hashing in
  JavaScript, which would be slower and no more private.

## relative-time

`<RelativeTime date={...} />` from utils. The rendering is
`@github/relative-time-element`, a registry `dependency` so `enigma add relative-time`
installs it the way `search` installs Fuse - it already owns `Intl.RelativeTimeFormat` per
locale and the re-render schedule that slows down as a date ages, and none of that is worth
re-implementing.

What the package adds is the part every wrapper writes badly:

- **A timestamp with no zone is UTC.** `2026-08-13 22:41:00` out of a date column has no
  offset, `new Date()` reads it as LOCAL, and every reader east or west of the server sees
  a time hours out - silently, because a wrong time is still a valid one. A date with NO
  clock is left alone: `YYYY-MM-DD` is already UTC per spec, and `YYYY-MM-DDZ` is outside
  the spec's grammar, so appending a zone drops a correct value into each engine's legacy
  parser. (V8 accepts it. That is not a guarantee.)
- **The absolute date is the element's child.** A custom element cannot upgrade during a
  server render and never upgrades with scripting off, so a bare `<relative-time>` is an
  empty box until hydration. The formatted date is rendered inside it; once the element
  upgrades it renders into a SHADOW ROOT and the child stops being shown.
- **The shadow root is why the capitalize hooks look odd.** `text-transform` is inherited,
  so it crosses the boundary from the host and reaches text no outer selector can match -
  but `::first-letter` only applies to a block container, and the element is inline. The
  `capitalizeFirst` hook was doing NOTHING until the host was made inline-block for it, and
  nothing caught that because it is a paint-only effect: it is absent from textContent, from
  the server markup and from every assertion that reads either.
- **`prefix` is set through the DOM, never as a React prop.** `Element.prototype.prefix` is
  a read-only accessor, and React sets a known property rather than an attribute - so
  passing it through throws and takes the whole tree down. Server-render tests could not see
  it: they never touch a DOM.
- **The element is imported on the client only**, and a failed import is swallowed. Its
  class extends `HTMLElement` at module scope, so importing it where there is no DOM throws
  before any component runs; and if it never arrives, the label above is already correct.
- **`numericBeyondThreshold` reads the threshold.** The version this came from approximated
  it with a hardcoded 3-to-90-day window, which disagrees with the `threshold` prop the
  moment anyone sets one. The ISO 8601 duration is parsed and compared instead.
- **The locale is not hardcoded.** Undefined lets the element read the closest `lang`,
  which is what a translated page wants; `locale` overrides it.
- `now` is a parameter throughout, so a test can pin the instant and a server render can
  hand its hydration the same one. Where it cannot, `suppressHydrationWarning` covers the
  one difference React has an escape hatch for rather than a bug.

`capitalize` / `capitalizeFirst` are data attributes, which means they need
`@enigmax/utils/relative-time.css` - the element writes its own text content, so nothing
JavaScript-side can transform it.

Agents should reach for this instead of formatting a date difference by hand, which is the
habit the GitHub skills encourage.

## The docs playground

The controls are the package's own components: a `type: "select"` control renders `<Select>`
and not `<select>`, so the docs are the first place a component has to hold up. The site
themes it through `--enigma-select-*` in `global.css` rather than by writing selectors.

`apps/web/src/components/playground/`. Every component page opens with a Customize panel
beside a live preview, and the code below is generated from the SAME state object that drove
the preview - one source, two outputs, so the sample and the thing you just used cannot
disagree. Modelled on appica.dev, which does the same.

Three decisions hold it up:

- **The preview is the real component**, imported from the package. That is why the site
  now depends on `packages/*` BY PATH rather than by version: it was pinned to a published
  0.5.0, four versions behind, so a live preview would have rendered something that no
  longer existed. The link immediately exposed two stale imports the pin had been hiding.
- **`client:only`, not `client:load`.** An interactive panel holding a `new Date()` cannot
  render identically on a server and in a browser, and the hydration mismatch was real.
- **The generated code carries only non-default props**, so it reads like something a person
  would have written rather than a dump of every option.

An engine that indexes on construction (search) is remounted by a `key` when an option
shapes it, with the query held outside and replayed - mutating the options would leave the
preview disagreeing with the panel.

Building it is also what put these components in a browser for the first time, which is how
the relative-time shadow-root bugs surfaced. A server-render test cannot see a crash that
needs a DOM, or a `::first-letter` rule that needs paint.

## enigma add

`packages/enigma-cli/src/components.ts`, wired in `cli.ts` as `add` (alias
`components`).

```
enigma add                     list the catalogue
enigma add --list <query>      search it
enigma add marquee             add as a dependency
enigma add marquee --copy      vendor the source in, shadcn style
enigma add --all               everything
  -p --path <dir>   where copies land
  -o --overwrite    replace files that are already there
  -c --cwd <dir>    run against another project
  -s --silent       failures only
  --target          vanilla | react | astro | vue | svelte (auto-detected)
  --style           tailwind | css | none (auto-detected)
  --no-deps         skip the packages an item declares
  --dry-run         report without writing
```

**Deliberately close to shadcn's CLI**, because that is the muscle memory people have: the
same short flags (`-a -o -c -p -s -y`), the same `--dry-run`, and `--list <query>` where it
has `search`. Two differences are on purpose:

- **A copy never overwrites without `-o`.** The point of copy mode is that the source
  becomes yours to edit, so a second `enigma add` that silently discarded those edits would
  be indistinguishable from one that worked. Existing files are kept and NAMED, because
  "left 3 files alone" is only actionable if you know which three.
- **A shadcn `components.json` is read, never written.** A project that has one has already
  said where components live and whether it uses Tailwind, so copies land beside the
  components shadcn writes instead of in a second folder of enigma's own. Writing to it
  would mean editing a file another tool owns. enigma's own preferences (`target`, `style`,
  `dest`) go under `components` in `.enigma.json`.

No `init`: there is nothing to scaffold, since the primitives bring no CSS variables and no
`cn`. No `build`: the registry is written by hand and copied into the CLI assets by
`npm run seal`.

**The registry is read from the package installed in the project first**, then a
monorepo checkout, then the copy bundled in the CLI assets. That order is the
whole point: an agent is shown the API the project actually compiles against, not
a catalogue frozen into a skill that drifts on the first upgrade. The bundled
copy is discovery-only, for listing before anything is installed, and is
refreshed by `scripts/sync-registry.mjs` (run by `npm run seal`).

Copy mode rewrites the `@/core/x` specifiers to relative ones using the `rewrite`
map in the registry entry, and refuses to run when the package source is not on
disk rather than inventing it.

## Adding a primitive

1. `src/core/<name>.ts`, plus an adapter per target it supports.
2. An entry in the package's `registry.json` - `files`, `rewrite`, `exports`,
   `themeHooks`, `docs`.
3. Tests that measure the real thing, not the engine's opinion of it.
4. A guardrail rule that catches the hand-rolled version and names the export.
5. `npm run sync:registry`, then a section here.
