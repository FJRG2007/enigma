# Component registry: primitives and utilities

Two published packages plus the `enigma add` command that puts them into a project.
They exist so the rules the frontend policy can only *persuade* an agent to follow
become a dependency it can *import*.

- `packages/primitives` -> `@enigmax/primitives`: interaction behaviour (timing,
  pointer handling, accessibility). Ships **no visual styles**.
- `packages/utils` -> `@enigmax/utils`: everything that is not UI - cache,
  notifications, and whatever comes next.

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

## input

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

## search

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

## enigma add

`packages/enigma-cli/src/components.ts`, wired in `cli.ts` as `add` (alias
`components`).

```
enigma add                     list the catalogue
enigma add marquee             add as a dependency
enigma add marquee --copy      vendor the source in, shadcn style
enigma add --all               everything
  --dest <dir>   where copies land (default src/lib/enigma)
  --target       vanilla | react | astro | vue | svelte (auto-detected)
  --dry-run      report without writing
```

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
